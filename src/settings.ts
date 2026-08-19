import type { PlatformConfig } from 'homebridge';

/** Must match the `platform` name users put in config.json. */
export const PLATFORM_NAME = 'ReadYourMeterPro';

/** Must match the `name` field in package.json. */
export const PLUGIN_NAME = 'homebridge-read-your-meter-pro';

/**
 * HomeKit's CurrentAmbientLightLevel is constrained to 0.0001..100000 lux.
 * Every numeric value we surface has to be clamped into that window.
 */
export const LUX_MIN = 0.0001;
export const LUX_MAX = 100000;

export type VolumeUnit = 'liters' | 'cubic_meters';

/** One sensor. Doubles as the HAP service subtype, so these strings are stable. */
export type SensorKey =
  | 'daily'
  | 'monthly'
  | 'forecast'
  | 'total'
  | 'daily-alert'
  | 'monthly-alert';

export const SENSOR_KEYS: readonly SensorKey[] = [
  'daily',
  'monthly',
  'forecast',
  'total',
  'daily-alert',
  'monthly-alert',
];

/**
 * Names used the first time a sensor is created. After that the name the user
 * picked wins — see MeterAccessory's name resolution.
 *
 * HomeKit requires names to start and end with a letter or digit and rejects
 * symbols like the superscript in "m³", so no units appear here.
 */
export const DEFAULT_NAMES: Record<SensorKey, string> = {
  daily: 'Water Usage Today',
  monthly: 'Water Usage This Month',
  forecast: 'Water Monthly Forecast',
  total: 'Water Meter Total',
  'daily-alert': 'Water Daily Alert',
  'monthly-alert': 'Water Monthly Alert',
};

export interface RymProPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  /** Minutes between polls. The upstream meter only refreshes hourly at best. */
  pollInterval?: number;
  /** Unit used for the daily / monthly / forecast light sensors. */
  unit?: VolumeUnit;
  /** Threshold in `unit` above which the daily leak sensor trips. 0 disables it. */
  dailyThreshold?: number;
  /** Threshold in `unit` above which the monthly leak sensor trips. 0 disables it. */
  monthlyThreshold?: number;
  exposeDaily?: boolean;
  exposeMonthly?: boolean;
  exposeForecast?: boolean;
  /** Total meter reading, always reported in m³ regardless of `unit`. */
  exposeTotal?: boolean;
  nameDaily?: string;
  nameMonthly?: string;
  nameForecast?: string;
  nameTotal?: string;
  nameDailyAlert?: string;
  nameMonthlyAlert?: string;
}

export interface ResolvedConfig {
  email: string;
  password: string;
  pollIntervalMs: number;
  unit: VolumeUnit;
  dailyThreshold: number;
  monthlyThreshold: number;
  /** Which sensors to expose. Absent keys are removed from the accessory. */
  expose: Record<SensorKey, boolean>;
  /**
   * Names pinned in config.json. These outrank both the default name and a
   * rename made in the Home app, which is the point of having them.
   */
  nameOverrides: Partial<Record<SensorKey, string>>;
}

export const MIN_POLL_MINUTES = 15;
export const DEFAULT_POLL_MINUTES = 60;

type Log = { error: (msg: string) => void; warn: (msg: string) => void };

/**
 * Validates user config. Returns null (and logs why) when the platform should
 * refuse to start — a verified plugin must not start until it is configured.
 */
export function resolveConfig(
  config: RymProPlatformConfig,
  log: Log,
): ResolvedConfig | null {
  const email = (config.email ?? '').trim();
  const password = config.password ?? '';

  if (!email || !password) {
    log.error(
      'Not starting: "email" and "password" are required. Configure the plugin in the Homebridge UI.',
    );
    return null;
  }

  let pollMinutes = Number(config.pollInterval ?? DEFAULT_POLL_MINUTES);
  if (!Number.isFinite(pollMinutes) || pollMinutes < MIN_POLL_MINUTES) {
    log.warn(
      `pollInterval of ${config.pollInterval} is below the ${MIN_POLL_MINUTES} minute floor; using ${MIN_POLL_MINUTES}. The meter itself updates at most hourly.`,
    );
    pollMinutes = MIN_POLL_MINUTES;
  }

  const unit: VolumeUnit = config.unit === 'cubic_meters' ? 'cubic_meters' : 'liters';
  const dailyThreshold = nonNegative(config.dailyThreshold);
  const monthlyThreshold = nonNegative(config.monthlyThreshold);

  const expose: Record<SensorKey, boolean> = {
    daily: config.exposeDaily !== false,
    monthly: config.exposeMonthly !== false,
    forecast: config.exposeForecast !== false,
    total: config.exposeTotal === true,
    // A threshold of 0 is the off switch for an alert: with no threshold to
    // compare against, the sensor would report a leak on every poll, since any
    // reading is >= 0.
    'daily-alert': dailyThreshold > 0,
    'monthly-alert': monthlyThreshold > 0,
  };

  if (!SENSOR_KEYS.some((key) => expose[key])) {
    log.warn(
      'Every sensor is switched off, so the accessory will appear in HomeKit with nothing on it.',
    );
  }

  return {
    email,
    password,
    pollIntervalMs: pollMinutes * 60_000,
    unit,
    dailyThreshold,
    monthlyThreshold,
    expose,
    nameOverrides: {
      daily: validName(config.nameDaily, 'nameDaily', log),
      monthly: validName(config.nameMonthly, 'nameMonthly', log),
      forecast: validName(config.nameForecast, 'nameForecast', log),
      total: validName(config.nameTotal, 'nameTotal', log),
      'daily-alert': validName(config.nameDailyAlert, 'nameDailyAlert', log),
      'monthly-alert': validName(config.nameMonthlyAlert, 'nameMonthlyAlert', log),
    },
  };
}

/**
 * HomeKit silently refuses to add an accessory whose name starts or ends with
 * anything other than a letter or digit. Letters are matched by Unicode class
 * so Hebrew names work as well as Latin ones.
 */
export function isValidHomeKitName(name: string): boolean {
  return /^[\p{L}\p{N}](?:[\p{L}\p{N} '’.,-]*[\p{L}\p{N}])?$/u.test(name);
}

function validName(value: unknown, field: string, log: Log): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim();
  if (name.length === 0) {
    return undefined;
  }
  if (!isValidHomeKitName(name)) {
    log.warn(
      `Ignoring ${field}: "${name}" is not a name HomeKit accepts. It must start and end with a ` +
        'letter or digit, and may only contain letters, digits, spaces, apostrophes, commas, ' +
        'periods and hyphens.',
    );
    return undefined;
  }
  return name;
}

function nonNegative(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
