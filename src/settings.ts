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

export interface RymProPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  /** Minutes between polls. The upstream meter only refreshes hourly at best. */
  pollInterval?: number;
  /** Unit used for the daily / monthly / forecast light sensors. */
  unit?: VolumeUnit;
  /** Threshold in `unit` above which the daily leak sensor trips. 0 disables. */
  dailyThreshold?: number;
  /** Threshold in `unit` above which the monthly leak sensor trips. 0 disables. */
  monthlyThreshold?: number;
  exposeForecast?: boolean;
  /** Total meter reading, always reported in m³ regardless of `unit`. */
  exposeTotal?: boolean;
  debug?: boolean;
}

export interface ResolvedConfig {
  email: string;
  password: string;
  pollIntervalMs: number;
  unit: VolumeUnit;
  dailyThreshold: number;
  monthlyThreshold: number;
  exposeForecast: boolean;
  exposeTotal: boolean;
  debug: boolean;
}

export const MIN_POLL_MINUTES = 15;
export const DEFAULT_POLL_MINUTES = 60;

/**
 * Validates user config. Returns null (and logs why) when the platform should
 * refuse to start — a verified plugin must not start until it is configured.
 */
export function resolveConfig(
  config: RymProPlatformConfig,
  log: { error: (msg: string) => void; warn: (msg: string) => void },
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

  return {
    email,
    password,
    pollIntervalMs: pollMinutes * 60_000,
    unit,
    dailyThreshold: nonNegative(config.dailyThreshold),
    monthlyThreshold: nonNegative(config.monthlyThreshold),
    exposeForecast: config.exposeForecast !== false,
    exposeTotal: config.exposeTotal === true,
    debug: config.debug === true,
  };
}

function nonNegative(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
