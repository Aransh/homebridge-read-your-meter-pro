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
 * How many days before today the daily lookup is willing to accept a figure
 * from. The portal returns a row for each day from midnight but leaves `cons`
 * null until that day's reading has been processed, and the lag is not a few
 * hours: on the account this was measured against, both today and yesterday were
 * null and the newest published day was two days back. Asking only about today
 * therefore never finds anything at all there. A week is enough to absorb that
 * lag plus a missed transmission or two; the day a figure belongs to is reported
 * alongside it, so a stale one is identifiable rather than silently passed off as
 * current.
 *
 * Seven days is also the minimum that always spans the weekly window, which the
 * weekly figure sums out of this same window: a calendar week starts at most six
 * days back, and the rolling window is seven days including today. Shortening
 * this would silently truncate the weekly total.
 */
const DAILY_LOOKBACK_DAYS = 7;

/** Length of the rolling weekly window, including today. */
const ROLLING_WEEK_DAYS = 7;

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

/**
 * What the weekly figure covers: the calendar week starting on the named day, or
 * a rolling seven days ending today.
 */
export type WeeklyWindow = 'sunday' | 'monday' | 'rolling';

export interface RymProClientOptions {
  /**
   * What the weekly total covers; defaults to a Sunday-start calendar week. The
   * daily window already spans either option, so the weekly figure is an
   * aggregate of data already fetched rather than another request.
   */
  weeklyWindow?: WeeklyWindow;
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

/** A row from either consumption endpoint. `cons` is null until published. */
interface ConsumptionRow {
  /** Local-time stamp of the period, e.g. "2026-08-20T00:00:00". */
  consDate?: unknown;
  cons?: unknown;
  [key: string]: unknown;
}

export interface MeterSnapshot {
  meterCount: number;
  /** Cumulative reading, m³. */
  total: number;
  /**
   * Consumption for the most recent day the portal has published, m³. Null when
   * it has published nothing within the lookback window — it returns a row with
   * `cons: null` until a day's reading is processed, which is not the same thing
   * as zero water used.
   */
  daily: number | null;
  /**
   * Which day `daily` is for, YYYY-MM-DD. Today when the portal has caught up,
   * an earlier date when it has not. Null when `daily` is null.
   */
  dailyDate: string | null;
  /**
   * Consumption over the configured weekly window, m³ — its published days,
   * summed. Null when the window has no published day yet, which is not the same
   * thing as no water used.
   */
  weekly: number | null;
  /** First day of the weekly window, YYYY-MM-DD. */
  weekStart: string;
  /**
   * How many days of the weekly window `weekly` actually covers, and how many
   * have begun. `2 of 4` says the total is missing two days to the publication
   * lag, which is the difference between a low week and an incomplete one.
   */
  weeklyDaysCounted: number;
  weeklyDaysElapsed: number;
  /** Consumption so far this month, m³. Null if no reading yet. */
  monthly: number | null;
  /** Forecast consumption for the full month, m³. Null if unavailable. */
  forecast: number | null;
  /** Physical meter serial, when reported. */
  serial?: string;
}

export class RymProClient {
  private token: string | null = null;
  private readonly weeklyWindow: WeeklyWindow;
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
    this.weeklyWindow = options.weeklyWindow ?? 'sunday';
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
      // One window request serves both the daily and the weekly figure.
      const published = await this.publishedDays(meterCount, today);
      const daily = published[0] ?? { value: null, date: null };
      const week = this.weeklyTotal(published, today);
      const monthly = await this.monthlyConsumption(meterCount, today);
      const forecast = await this.forecast(meterCount);

      snapshots.push({
        meterCount,
        total: toNumber(meter.read) ?? 0,
        daily: daily.value,
        dailyDate: daily.date,
        weekly: week.value,
        weekStart: week.start,
        weeklyDaysCounted: week.counted,
        weeklyDaysElapsed: week.elapsed,
        monthly,
        forecast,
        serial: typeof meter.meterId === 'string' ? meter.meterId : undefined,
      });
    }
    return snapshots;
  }

  /**
   * Every day in the lookback window the portal has actually published, newest
   * first. Empty when it has published nothing — which is not the same thing as
   * zero water used, so callers must not read that as a zero.
   *
   * Sorted rather than taken in order: the portal happens to return the range
   * ascending, but nothing documents that, and reading a figure off a fixed
   * position was the original bug.
   */
  private async publishedDays(
    meterCount: number,
    today: string,
  ): Promise<Array<{ value: number; date: string }>> {
    const from = shiftDays(today, -DAILY_LOOKBACK_DAYS);
    const rows = await this.get<ConsumptionRow[]>(
      `${CONSUMPTION_URL}/daily/${meterCount}/${from}/${today}`,
    );
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .map((row) => ({ value: toNumber(row?.cons), date: rowDate(row) }))
      .filter((row): row is { value: number; date: string } => row.value !== null && row.date !== null)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Consumption over the configured weekly window. By default that is the
   * calendar week containing `today`, which resets on its start day the way the
   * monthly figure resets on the first of the month; `rolling` instead covers the
   * seven days ending today, which never resets and so is never nearly empty.
   *
   * The publication lag means the total is normally missing its most recent day
   * or two, so the day counts come back with it. A window with nothing published
   * yet is null rather than zero: in the first days of a calendar week that is
   * every day of it.
   */
  private weeklyTotal(
    published: Array<{ value: number; date: string }>,
    today: string,
  ): { value: number | null; start: string; counted: number; elapsed: number } {
    const start =
      this.weeklyWindow === 'rolling'
        ? shiftDays(today, -(ROLLING_WEEK_DAYS - 1))
        : weekStart(today, this.weeklyWindow === 'monday' ? 1 : 0);
    const inWeek = published.filter((day) => day.date >= start && day.date <= today);
    const elapsed = daysBetween(start, today) + 1;

    if (inWeek.length === 0) {
      return { value: null, start, counted: 0, elapsed };
    }
    return {
      value: inWeek.reduce((sum, day) => sum + day.value, 0),
      start,
      counted: inWeek.length,
      elapsed,
    };
  }

  /**
   * Consumption for the calendar month containing `date`. The endpoint keys off
   * the month the range falls in rather than the range itself — asked about a
   * single day it answers with a row dated to the first of that month, carrying
   * the month-to-date total — so a one-day range is all it needs.
   */
  private async monthlyConsumption(meterCount: number, date: string): Promise<number | null> {
    const rows = await this.get<ConsumptionRow[]>(
      `${CONSUMPTION_URL}/monthly/${meterCount}/${date}/${date}`,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }
    return toNumber(rows[0]?.cons);
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

/**
 * The YYYY-MM-DD a row belongs to. `consDate` carries a time component that is
 * always midnight local, so it is truncated rather than parsed — going through
 * `Date` would reinterpret it as UTC and shift the day.
 */
function rowDate(row: ConsumptionRow | undefined): string | null {
  const value = row?.consDate;
  if (typeof value !== 'string') {
    return null;
  }
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/** Shifts a YYYY-MM-DD by whole days, staying on calendar days across DST. */
function shiftDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  // Noon, so that a DST transition cannot round the result onto the wrong day.
  const shifted = new Date(year, month - 1, day + days, 12);
  return localDate(shifted);
}

/** Midday local Date for a YYYY-MM-DD, safe to do day arithmetic on. */
function noon(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

/**
 * First day of the calendar week containing `date`. `startsOn` is 0 for Sunday,
 * matching `Date.getDay`. Exported so the smoke test can check both start days
 * against known dates rather than only whichever weekday it happens to run on.
 */
export function weekStart(date: string, startsOn: 0 | 1): string {
  const offset = (noon(date).getDay() - startsOn + 7) % 7;
  return shiftDays(date, -offset);
}

/** Whole days from `from` to `to`. Both are YYYY-MM-DD. */
function daysBetween(from: string, to: string): number {
  return Math.round((noon(to).getTime() - noon(from).getTime()) / 86_400_000);
}

function toNumber(value: unknown): number | null {
  // `Number(null)` is 0 and `Number('')` is 0, so both have to be rejected
  // before the coercion: the portal uses null for "not published yet", and
  // reporting that as zero consumption is the thing this plugin must not do.
  if (value === null || value === undefined || value === '') {
    return null;
  }
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
