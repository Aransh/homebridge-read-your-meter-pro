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

/**
 * Minimum gap between two outbound requests. The portal rate-limits bursts, and
 * the handful of requests a poll makes have no reason to be simultaneous.
 */
const REQUEST_SPACING_MS = 250;

/**
 * Delay before each retry of a rate-limited request, in order. The length of
 * this list is the retry budget: three retries, so a poll spends at most ~40s
 * waiting rather than stalling into the next one.
 */
const RATE_LIMIT_BACKOFF_MS = [2_000, 8_000, 30_000];

/**
 * Longest `Retry-After` worth honouring inline. Beyond this the portal is asking
 * for more patience than a single poll has; the next poll is a better place to
 * try again.
 */
const MAX_RETRY_AFTER_MS = 60_000;

export class CannotConnectError extends Error {}
export class UnauthorizedError extends Error {}
export class OperationError extends Error {}

/**
 * HTTP 429. Subclasses OperationError so callers that only care that a request
 * failed need no changes.
 */
export class RateLimitedError extends OperationError {
  constructor(
    message: string,
    /** How long the portal asked us to wait, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface RymProClientOptions {
  /** Receives a freshly issued token so it can be persisted. */
  onToken?: (token: string) => void;
  /** Retry diagnostics, wired to the Homebridge debug log. */
  onRetry?: (message: string) => void;
  /** Aborts in-flight requests and pending backoff when Homebridge shuts down. */
  signal?: AbortSignal;
}

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
  private readonly onToken?: (token: string) => void;
  private readonly onRetry?: (message: string) => void;
  private readonly signal?: AbortSignal;
  /**
   * Earliest moment the next request may be sent. Requests are issued strictly
   * one at a time (see fetchAllOnce), so a single timestamp is enough to pace
   * them without a queue.
   */
  private nextRequestAt = 0;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly deviceId: string,
    options: RymProClientOptions = {},
  ) {
    this.onToken = options.onToken;
    this.onRetry = options.onRetry;
    this.signal = options.signal;
  }

  setToken(token: string): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  async login(): Promise<string> {
    const json = await this.withRetry('/consumer/login', () => this.loginOnce());

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

  private loginOnce(): Promise<Record<string, unknown>> {
    return this.paced(async () => {
      let response: Response;
      try {
        response = await fetch(`${CONSUMER_URL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: this.email,
            pw: this.password,
            deviceId: this.deviceId,
          }),
          signal: this.requestSignal(),
        });
      } catch (error) {
        throw new CannotConnectError(describe(error));
      }
      // Checked before parsing: a rate-limited response is usually an HTML or
      // empty body, so parsing it first would report a JSON error instead.
      if (response.status === 429) {
        throw rateLimited(response, '/consumer/login');
      }
      try {
        return (await response.json()) as Record<string, unknown>;
      } catch (error) {
        throw new CannotConnectError(describe(error));
      }
    });
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
      // Issued one at a time rather than with Promise.all. Four near-simultaneous
      // requests is what trips the portal's rate limiter, and a 429 on the first
      // of them costs the whole poll. A poll has an hour to complete; there is
      // nothing to gain from a burst.
      const daily = await this.periodConsumption('daily', meterCount, today);
      const monthly = await this.periodConsumption('monthly', meterCount, today);
      const forecast = await this.forecast(meterCount);

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
    const token = this.token;
    if (!token) {
      throw new OperationError('Not logged in');
    }
    return this.withRetry(redact(url), () => this.getOnce<T>(url, token));
  }

  private getOnce<T>(url: string, token: string): Promise<T> {
    return this.paced(async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': token,
          },
          signal: this.requestSignal(),
        });
      } catch (error) {
        throw new OperationError(describe(error));
      }

      if (response.status === 401) {
        throw new UnauthorizedError(`401 from ${redact(url)}`);
      }
      if (response.status === 429) {
        throw rateLimited(response, redact(url));
      }
      if (!response.ok) {
        throw new OperationError(`HTTP ${response.status} from ${redact(url)}`);
      }
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new OperationError(`Malformed JSON from ${redact(url)}: ${describe(error)}`);
      }
    });
  }

  /**
   * Runs a request, retrying only on HTTP 429. Everything else is left to the
   * caller: a 401 has its own recovery path, and a connection failure or a
   * malformed response is not improved by asking again immediately.
   */
  private async withRetry<T>(label: string, send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof RateLimitedError)) {
          throw error;
        }
        const delay = backoffFor(error, attempt);
        if (delay === null) {
          throw error;
        }
        this.onRetry?.(
          `Rate limited on ${label}; waiting ${(delay / 1000).toFixed(1)}s before retry ` +
            `${attempt + 1} of ${RATE_LIMIT_BACKOFF_MS.length}.`,
        );
        await sleep(delay, this.signal);
      }
    }
  }

  /** Holds a request back until the spacing since the previous one has elapsed. */
  private async paced<T>(send: () => Promise<T>): Promise<T> {
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) {
      await sleep(wait, this.signal);
    }
    try {
      return await send();
    } finally {
      this.nextRequestAt = Date.now() + REQUEST_SPACING_MS;
    }
  }

  /** Per-request timeout, also tripped by the shutdown signal when there is one. */
  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
  }
}

function rateLimited(response: Response, label: string): RateLimitedError {
  return new RateLimitedError(
    `HTTP 429 from ${label}`,
    parseRetryAfter(response.headers.get('retry-after')),
  );
}

/** Delay before the next attempt, or null when the request should be given up on. */
function backoffFor(error: RateLimitedError, attempt: number): number | null {
  if (attempt >= RATE_LIMIT_BACKOFF_MS.length) {
    return null;
  }
  const asked = error.retryAfterMs;
  if (asked !== null) {
    // The portal said how long to wait, so honour it — plus a random pad, so
    // that several instances rate-limited together do not all come back on the
    // same second.
    return asked <= MAX_RETRY_AFTER_MS ? asked + Math.random() * 1_000 : null;
  }
  // Jittered, for the same reason: a fixed ladder synchronises every client
  // that was throttled in the same window.
  return RATE_LIMIT_BACKOFF_MS[attempt] * (0.75 + Math.random() * 0.5);
}

/** `Retry-After` is either a count of seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | null {
  const value = header?.trim();
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/** Cancellable delay. Rejects rather than resolving late when Homebridge stops. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationError('shutting down'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OperationError('shutting down'));
    };
    // Deliberately not unref'd: the wait is part of an in-flight poll, and
    // dropping it would abandon the request halfway. Shutdown is handled by the
    // signal instead, which rejects immediately.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
