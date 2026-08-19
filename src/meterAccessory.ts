import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { RymProPlatform } from './platform.js';
import type { MeterSnapshot } from './rympro.js';
import {
  DEFAULT_NAMES,
  isValidHomeKitName,
  LUX_MAX,
  LUX_MIN,
  SENSOR_KEYS,
  type ResolvedConfig,
  type SensorKey,
  type VolumeUnit,
} from './settings.js';

interface ServiceSpec {
  key: SensorKey;
  name: string;
  kind: 'light' | 'leak';
}

const SENSOR_KINDS: Record<SensorKey, 'light' | 'leak'> = {
  daily: 'light',
  monthly: 'light',
  forecast: 'light',
  total: 'light',
  'daily-alert': 'leak',
  'monthly-alert': 'leak',
};

export class MeterAccessory {
  private readonly services = new Map<SensorKey, Service>();
  private readonly unit: VolumeUnit;
  private readonly information: Service;
  /**
   * Names the user has chosen, kept in the accessory context so they live in
   * Homebridge's accessory cache and survive a restart.
   */
  private readonly savedNames: Partial<Record<SensorKey, string>>;

  constructor(
    private readonly platform: RymProPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly config: ResolvedConfig,
  ) {
    this.unit = config.unit;
    const { Service, Characteristic } = platform;
    const context = accessory.context as {
      meterCount?: number;
      names?: Partial<Record<SensorKey, string>>;
    };
    this.savedNames = (context.names ??= {});

    this.information = (
      accessory.getService(Service.AccessoryInformation) ??
      accessory.addService(Service.AccessoryInformation)
    )
      .setCharacteristic(Characteristic.Manufacturer, 'Arad / Read Your Meter Pro')
      .setCharacteristic(Characteristic.Model, 'Water Meter')
      .setCharacteristic(Characteristic.SerialNumber, String(context.meterCount));

    this.buildServices();
  }

  /**
   * The name a sensor should carry. A name pinned in config.json wins, so there
   * is always a way to force a name from the Homebridge UI; otherwise whatever
   * the user last set in the Home app wins; the built-in name is only the
   * starting point.
   */
  private nameFor(key: SensorKey): string {
    const override = this.config.nameOverrides[key];
    if (override) {
      return override;
    }
    const saved = this.savedNames[key];
    if (saved && isValidHomeKitName(saved)) {
      return saved;
    }
    return DEFAULT_NAMES[key];
  }

  /** Which services this accessory should expose, given the current config. */
  private desiredServices(): ServiceSpec[] {
    return SENSOR_KEYS.filter((key) => this.config.expose[key]).map((key) => ({
      key,
      name: this.nameFor(key),
      kind: SENSOR_KINDS[key],
    }));
  }

  private buildServices(): void {
    const { Service, Characteristic } = this.platform;
    const specs = this.desiredServices();
    const wanted = new Set<string>(specs.map((s) => s.key));

    // Remove services left over from a previous config (e.g. a sensor that was
    // switched off, or a threshold that was set back to 0).
    for (const service of [...this.accessory.services]) {
      const subtype = service.subtype;
      if (
        service.UUID !== Service.AccessoryInformation.UUID &&
        subtype !== undefined &&
        !wanted.has(subtype)
      ) {
        this.platform.log.info(
          `Removing no-longer-configured service "${service.displayName}" from ${this.accessory.displayName}`,
        );
        this.accessory.removeService(service);
      }
    }

    for (const spec of specs) {
      const type = spec.kind === 'light' ? Service.LightSensor : Service.LeakSensor;
      const existing = this.accessory.getServiceById(type, spec.key);
      const service = existing ?? this.accessory.addService(type, spec.name, spec.key);

      // Installs that predate name persistence have the user's rename on the
      // restored service but nothing in the context; adopt it rather than
      // resetting them one last time.
      if (existing && !this.savedNames[spec.key]) {
        this.adoptExistingName(spec, existing);
      }

      const name = this.nameFor(spec.key);
      service.setCharacteristic(Characteristic.Name, name);
      if (Characteristic.ConfiguredName) {
        // Lets the Home app show a sane per-service label instead of "Sensor",
        // and is what the Home app writes back when the user renames a tile.
        if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
          service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        service.updateCharacteristic(Characteristic.ConfiguredName, name);
        service
          .getCharacteristic(Characteristic.ConfiguredName)
          .onSet((value) => this.rememberName(spec.key, value));
      }
      service.setCharacteristic(Characteristic.StatusActive, true);
      service.setCharacteristic(
        Characteristic.StatusFault,
        Characteristic.StatusFault.NO_FAULT,
      );

      this.services.set(spec.key, service);
    }
  }

  private adoptExistingName(spec: ServiceSpec, service: Service): void {
    const current = service.testCharacteristic(this.platform.Characteristic.ConfiguredName)
      ? service.getCharacteristic(this.platform.Characteristic.ConfiguredName).value
      : service.getCharacteristic(this.platform.Characteristic.Name).value;
    if (
      typeof current === 'string' &&
      current !== DEFAULT_NAMES[spec.key] &&
      isValidHomeKitName(current)
    ) {
      this.savedNames[spec.key] = current;
      this.platform.saveAccessoryContext(this.accessory);
    }
  }

  /** Records a rename made in the Home app so the next restart keeps it. */
  private rememberName(key: SensorKey, value: CharacteristicValue): void {
    const name = String(value).trim();
    if (name.length === 0 || !isValidHomeKitName(name)) {
      return;
    }
    if (this.savedNames[key] === name) {
      return;
    }
    this.savedNames[key] = name;
    this.platform.saveAccessoryContext(this.accessory);
    const override = this.config.nameOverrides[key];
    if (override && override !== name) {
      this.platform.log.warn(
        `Renamed "${key}" to "${name}", but config.json pins it to "${override}", ` +
          'which will win on the next restart. Clear that setting to keep renaming from the Home app.',
      );
    } else {
      this.platform.log.info(`Remembered the new name for "${key}": ${name}`);
    }
  }

  update(snapshot: MeterSnapshot): void {
    const { Characteristic } = this.platform;
    const factor = this.unit === 'liters' ? 1000 : 1;

    const scale = (v: number | null) => (v === null ? null : v * factor);
    const daily = scale(snapshot.daily);
    const monthly = scale(snapshot.monthly);

    // A null reading means "not published yet", not "zero". Leaving the last
    // known value in place beats flashing a zero every morning; the very first
    // poll has nothing to keep, so it floors instead.
    this.setLux('daily', daily);
    this.setLux('monthly', monthly);
    this.setLux('forecast', scale(snapshot.forecast));
    // Total is always m³: a cumulative reading in litres blows past the
    // 100000 lux ceiling within a couple of years of normal household use.
    this.setLux('total', snapshot.total);

    if (snapshot.serial) {
      // The physical serial only arrives with the first poll, so it cannot be
      // set in the constructor.
      this.information.updateCharacteristic(Characteristic.SerialNumber, snapshot.serial);
    }

    // With no reading there is nothing to compare, so the alert stays clear
    // rather than tripping or clearing on invented data.
    if (daily !== null) {
      this.setLeak('daily-alert', daily >= this.config.dailyThreshold);
    }
    if (monthly !== null) {
      this.setLeak('monthly-alert', monthly >= this.config.monthlyThreshold);
    }

    for (const service of this.services.values()) {
      service.updateCharacteristic(Characteristic.StatusActive, true);
      service.updateCharacteristic(
        Characteristic.StatusFault,
        Characteristic.StatusFault.NO_FAULT,
      );
    }

    const unitLabel = this.unit === 'liters' ? 'L' : 'm³';
    const show = (v: number | null) => (v === null ? 'no reading yet' : `${round(v)}${unitLabel}`);
    this.platform.log.debug(
      `Meter ${snapshot.meterCount}: today=${show(daily)} month=${show(monthly)} ` +
        `forecast=${show(scale(snapshot.forecast))} total=${round(snapshot.total)}m³`,
    );
  }

  /** Flags every service as faulted so the failure is visible in the Home app. */
  setFaulted(): void {
    const { Characteristic } = this.platform;
    for (const service of this.services.values()) {
      service.updateCharacteristic(Characteristic.StatusActive, false);
      service.updateCharacteristic(
        Characteristic.StatusFault,
        Characteristic.StatusFault.GENERAL_FAULT,
      );
    }
  }

  private setLux(key: SensorKey, value: number | null): void {
    const service = this.services.get(key);
    if (!service) {
      return;
    }
    if (value === null) {
      // Keep whatever was last published rather than reporting a false zero.
      return;
    }
    if (value > LUX_MAX) {
      this.platform.log.warn(
        `${service.displayName}: ${round(value)} exceeds HomeKit's 100000 lux ceiling and was clamped. ` +
          'Switch "unit" to cubic_meters if this keeps happening.',
      );
    }
    service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      clampLux(value),
    );
  }

  private setLeak(key: SensorKey, tripped: boolean): void {
    const service = this.services.get(key);
    if (!service) {
      return;
    }
    const { Characteristic } = this.platform;
    service.updateCharacteristic(
      Characteristic.LeakDetected,
      tripped
        ? Characteristic.LeakDetected.LEAK_DETECTED
        : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
    );
  }
}

/**
 * HomeKit rejects values outside 0.0001..100000 lux, and a real zero reading is
 * common right after midnight, so genuine zeroes have to floor at 0.0001.
 */
export function clampLux(value: number): number {
  if (!Number.isFinite(value)) {
    return LUX_MIN;
  }
  return Math.min(LUX_MAX, Math.max(LUX_MIN, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
