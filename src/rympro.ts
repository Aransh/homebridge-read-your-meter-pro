/**
 * Minimal client for the Read Your Meter Pro customer portal API.
 *
 * The endpoint layout and the 5060 error code were derived from `pyrympro`
 * (MIT, Copyright (c) 2022 On Freund) — see THIRD-PARTY-NOTICES.md.
 */

const BASE_URL = 'https://eu-customerportal-api.harmonyencoremdm.com';
const CONSUMER_URL = `${BASE_URL}/consumer`;
const CONSUMPTION_URL = `${BASE_URL}/consumption`;

const REQUEST_TIMEOUT_MS = 30_000;

export class CannotConnectError extends Error {}
export class UnauthorizedError extends Error {}
export class OperationError extends Error {}

export interface MeterRead {
  /** Identifier used in the consumption endpoint paths. */
  meterCount: number;
  /** Physical meter serial, zero-padded string e.g. "000811515025". */
  meterId?: string;
  /** Cumulative meter reading, in m³. */
  read: number;
  [key: string]: unknown;
}

export interface MeterSnapshot {
  meterCount: number;
  /** Cumulative reading, m³. */
  total: number;
  /**
   * Consumption so far today, m³. Null when the portal has produced no reading
   * for today yet — it returns a row with `cons: null` for much of the day,
   * which is not the same thing as zero water used.
   */
  daily: number | null;
  /** Consumption so far this month, m³. Null if no reading yet. */
  monthly: number | null;
  /** Forecast consumption for the full month, m³. Null if unavailable. */
  forecast: number | null;
  /** Physical meter serial, when reported. */
  serial?: string;
}

export class RymProClient {
  private token: string | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly deviceId: string,
    private readonly onToken?: (token: string) => void,
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  async login(): Promise<string> {
    let json: Record<string, unknown>;
    try {
      const response = await fetch(`${CONSUMER_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.email,
          pw: this.password,
          deviceId: this.deviceId,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      json = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      throw new CannotConnectError(describe(error));
    }

    const token = json.token as string | undefined;
    const errorCode = json.code as number | undefined;
    const errorMessage = (json.error as string | undefined) ?? 'unknown error';

    if (errorCode === 5060) {
      throw new UnauthorizedError(errorMessage);
    }
    if (!token || errorCode) {
      throw new CannotConnectError(`code: ${errorCode}, error: ${errorMessage}`);
    }

    this.token = token;
    this.onToken?.(token);
    return token;
  }

  /**
   * Fetches everything the plugin needs, re-authenticating once if the stored
   * token has expired.
   */
  async fetchAll(): Promise<MeterSnapshot[]> {
    if (!this.token) {
      await this.login();
    }
    try {
      return await this.fetchAllOnce();
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        throw error;
      }
      this.token = null;
      await this.login();
      return this.fetchAllOnce();
    }
  }

  private async fetchAllOnce(): Promise<MeterSnapshot[]> {
    const meters = await this.get<MeterRead[]>(`${CONSUMPTION_URL}/last-read`);
    const today = localDate();

    const snapshots: MeterSnapshot[] = [];
    for (const meter of meters) {
      const meterCount = meter.meterCount;
      const [daily, monthly, forecast] = await Promise.all([
        this.periodConsumption('daily', meterCount, today),
        this.periodConsumption('monthly', meterCount, today),
        this.forecast(meterCount),
      ]);

      snapshots.push({
        meterCount,
        total: toNumber(meter.read) ?? 0,
        daily,
        monthly,
        forecast,
        serial: typeof meter.meterId === 'string' ? meter.meterId : undefined,
      });
    }
    return snapshots;
  }

  private async periodConsumption(
    period: 'daily' | 'monthly',
    meterCount: number,
    date: string,
  ): Promise<number | null> {
    const rows = await this.get<Array<{ cons?: unknown }>>(
      `${CONSUMPTION_URL}/${period}/${meterCount}/${date}/${date}`,
    );
    // Two distinct "no data" shapes: an empty array, or a row whose `cons` is
    // explicitly null. Both mean the reading has not been produced yet, which
    // must not be reported as zero consumption.
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }
    const cons = rows[0]?.cons;
    if (cons === null || cons === undefined) {
      return null;
    }
    return toNumber(cons);
  }

  private async forecast(meterId: number): Promise<number | null> {
    try {
      const result = await this.get<{ estimatedConsumption?: unknown }>(
        `${CONSUMPTION_URL}/forecast/${meterId}`,
      );
      return toNumber(result?.estimatedConsumption);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      // Forecast is the flakiest endpoint and the least important; a failure
      // here should not cost us the whole poll.
      return null;
    }
  }

  private async get<T>(url: string): Promise<T> {
    if (!this.token) {
      throw new OperationError('Not logged in');
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': this.token,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OperationError(describe(error));
    }

    if (response.status === 401) {
      throw new UnauthorizedError(`401 from ${redact(url)}`);
    }
    if (!response.ok) {
      throw new OperationError(`HTTP ${response.status} from ${redact(url)}`);
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new OperationError(`Malformed JSON from ${redact(url)}: ${describe(error)}`);
    }
  }
}

/** YYYY-MM-DD in the host's local timezone — the meter reports on local days. */
function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function redact(url: string): string {
  return url.replace(BASE_URL, '');
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'request timed out' : error.message;
  }
  return String(error);
}
