import type { PlatformAccessory, Service } from 'homebridge';

import type { RymProPlatform } from './platform.js';
import type { MeterSnapshot } from './rympro.js';
import { LUX_MAX, LUX_MIN, type ResolvedConfig, type VolumeUnit } from './settings.js';

type SubType =
  | 'daily'
  | 'monthly'
  | 'forecast'
  | 'total'
  | 'daily-alert'
  | 'monthly-alert';

interface ServiceSpec {
  subtype: SubType;
  name: string;
  kind: 'light' | 'leak';
}

export class MeterAccessory {
  private readonly services = new Map<SubType, Service>();
  private readonly unit: VolumeUnit;

  constructor(
    private readonly platform: RymProPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly config: ResolvedConfig,
  ) {
    this.unit = config.unit;
    const { Service, Characteristic } = platform;
    const meterCount = accessory.context.meterCount as number;

    (
      accessory.getService(Service.AccessoryInformation) ??
      accessory.addService(Service.AccessoryInformation)
    )
      .setCharacteristic(Characteristic.Manufacturer, 'Arad / Read Your Meter Pro')
      .setCharacteristic(Characteristic.Model, 'Water Meter')
      .setCharacteristic(Characteristic.SerialNumber, String(meterCount));

    this.buildServices();
  }

  /** Which services this accessory should expose, given the current config. */
  private desiredServices(): ServiceSpec[] {
    // HomeKit requires names to start and end with a letter or digit, and
    // rejects symbols like the superscript in "m³" — so no units in the name.
    // The unit is a config choice and is documented in the plugin settings.
    const specs: ServiceSpec[] = [
      { subtype: 'daily', name: 'Water Today', kind: 'light' },
      { subtype: 'monthly', name: 'Water This Month', kind: 'light' },
    ];

    if (this.config.exposeForecast) {
      specs.push({ subtype: 'forecast', name: 'Water Forecast', kind: 'light' });
    }
    if (this.config.exposeTotal) {
      specs.push({ subtype: 'total', name: 'Water Meter Total', kind: 'light' });
    }
    if (this.config.dailyThreshold > 0) {
      specs.push({ subtype: 'daily-alert', name: 'Water Daily Alert', kind: 'leak' });
    }
    if (this.config.monthlyThreshold > 0) {
      specs.push({ subtype: 'monthly-alert', name: 'Water Monthly Alert', kind: 'leak' });
    }
    return specs;
  }

  private buildServices(): void {
    const { Service, Characteristic } = this.platform;
    const specs = this.desiredServices();
    const wanted = new Set<string>(specs.map((s) => s.subtype));

    // Remove services left over from a previous config (e.g. a threshold that
    // was set to 0, or the forecast sensor being switched off).
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
      const service =
        this.accessory.getServiceById(type, spec.subtype) ??
        this.accessory.addService(type, spec.name, spec.subtype);

      service.setCharacteristic(Characteristic.Name, spec.name);
      if (Characteristic.ConfiguredName) {
        // Lets the Home app show a sane per-service label instead of "Sensor".
        if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
          service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        service.updateCharacteristic(Characteristic.ConfiguredName, spec.name);
      }
      service.setCharacteristic(Characteristic.StatusActive, true);
      service.setCharacteristic(
        Characteristic.StatusFault,
        Characteristic.StatusFault.NO_FAULT,
      );

      this.services.set(spec.subtype, service);
    }
  }

  update(snapshot: MeterSnapshot): void {
    const { Characteristic } = this.platform;
    const factor = this.unit === 'liters' ? 1000 : 1;

    const daily = snapshot.daily * factor;
    const monthly = snapshot.monthly * factor;

    this.setLux('daily', daily);
    this.setLux('monthly', monthly);
    if (snapshot.forecast !== null) {
      this.setLux('forecast', snapshot.forecast * factor);
    }
    // Total is always m³: a cumulative reading in litres blows past the
    // 100000 lux ceiling within a couple of years of normal household use.
    this.setLux('total', snapshot.total);

    this.setLeak('daily-alert', daily >= this.config.dailyThreshold);
    this.setLeak('monthly-alert', monthly >= this.config.monthlyThreshold);

    for (const service of this.services.values()) {
      service.updateCharacteristic(Characteristic.StatusActive, true);
      service.updateCharacteristic(
        Characteristic.StatusFault,
        Characteristic.StatusFault.NO_FAULT,
      );
    }

    const unitLabel = this.unit === 'liters' ? 'L' : 'm³';
    this.platform.debug(
      `Meter ${snapshot.meterCount}: today=${round(daily)}${unitLabel} ` +
        `month=${round(monthly)}${unitLabel} ` +
        `forecast=${snapshot.forecast === null ? 'n/a' : round(snapshot.forecast * factor) + unitLabel} ` +
        `total=${round(snapshot.total)}m³`,
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

  private setLux(subtype: SubType, value: number): void {
    const service = this.services.get(subtype);
    if (!service) {
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

  private setLeak(subtype: SubType, tripped: boolean): void {
    const service = this.services.get(subtype);
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
