/**
 * Smoke test: drives the compiled plugin against a fake RYM Pro API and a
 * minimal Homebridge API shim built on the real HAP-NodeJS classes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlatformAccessory } from '../node_modules/homebridge/dist/platformAccessory.js';
import { Characteristic, Service, uuid } from '@homebridge/hap-nodejs';

import plugin from '../dist/index.js';

// ---------------------------------------------------------------- fake server

const calls = [];
let loginCount = 0;
let expireNextGet = false;

const METER_ID = 55123;
const METER_SERIAL = '000811515025';

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const today = () => ymd(new Date());
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
};

/**
 * What the weekly sensor should read, worked out independently of the plugin:
 * the days-ago offsets that fall in the calendar week containing today, summed.
 * The suite runs on whatever weekday it runs on, so the expectation has to be
 * derived rather than hard-coded — hard-coding one would pass six days a week.
 */
const expectedWeek = (published, startsOn = 0) => {
  const sinceStart = (new Date().getDay() - startsOn + 7) % 7;
  const offsets = Array.from({ length: sinceStart + 1 }, (_, i) => i).filter(
    (o) => typeof published[o] === 'number',
  );
  return {
    liters: offsets.reduce((sum, o) => sum + published[o], 0) * 1000,
    counted: offsets.length,
    elapsed: sinceStart + 1,
  };
};

/** Floating-point-tolerant compare: 0.734 + 0.512 does not land on 1.246. */
const assertLitres = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) < 0.01,
    `${label}: expected ${expected} L, got ${actual} L`,
  );

/**
 * What the fake portal has published for each day, keyed by how many days ago
 * it was. `null` is the real "row exists, figure not processed yet" shape, which
 * is what the portal serves for today for hours — on some accounts, all day.
 */
let dailyPublished = { 0: 0.734, 1: 0.512, 2: 0.498, 3: 0.501 };
let dailyIsNull = false;

/** Enumerates a from/to range the way the daily endpoint does: one row per day. */
const dailyRows = (from, to) => {
  const rows = [];
  for (let offset = 10; offset >= 0; offset -= 1) {
    const date = daysAgo(offset);
    if (date < from || date > to) {
      continue;
    }
    const cons = dailyIsNull ? null : (dailyPublished[offset] ?? null);
    rows.push({
      meterCount: METER_ID,
      consDate: `${date}T00:00:00`,
      cons,
      estimationType: cons === null ? 0 : 1,
      commonCons: 0,
      meterStatusDesc: '-',
    });
  }
  return rows;
};

const apiFetch = async (url, init = {}) => {
  calls.push(`${init.method ?? 'GET'} ${String(url).replace(/^https:\/\/[^/]+/, '')}`);
  const path = new URL(url).pathname;

  if (path === '/consumer/login') {
    const body = JSON.parse(init.body);
    loginCount += 1;
    if (body.pw !== 'correct-horse') {
      return json({ code: 5060, error: 'Invalid credentials' });
    }
    assert.ok(body.deviceId, 'login must send a deviceId');
    assert.equal(body.email, 'aran@example.com');
    return json({ token: `token-${loginCount}` });
  }

  if (expireNextGet) {
    expireNextGet = false;
    return new Response('', { status: 401 });
  }
  assert.match(init.headers['x-access-token'], /^token-/);

  if (path === '/consumption/last-read') {
    return json([{ meterCount: METER_ID, meterId: METER_SERIAL, read: 812.345 }]);
  }
  if (path.startsWith(`/consumption/daily/${METER_ID}/`)) {
    const [from, to] = path.split('/').slice(-2);
    assert.match(from, /^\d{4}-\d{2}-\d{2}$/, 'daily range start must be a date');
    assert.match(to, /^\d{4}-\d{2}-\d{2}$/, 'daily range end must be a date');
    assert.equal(to, today(), 'the daily range must end at today');
    assert.ok(from < to, 'the daily range must look back past today');
    return json(dailyRows(from, to));
  }
  if (path.startsWith(`/consumption/monthly/${METER_ID}/`)) {
    // The month total, dated to the first of the month — the portal keys off the
    // month the requested range falls in, not the range itself.
    return json([
      {
        meterCount: METER_ID,
        consDate: `${today().slice(0, 7)}-01T00:00:00`,
        cons: 14.2,
        estimationType: 1,
        commonCons: 0,
        meterStatusDesc: '-',
      },
    ]);
  }
  if (path === `/consumption/forecast/${METER_ID}`) {
    return json({ estimatedConsumption: 21.8 });
  }
  return new Response('', { status: 404 });
};

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Request bookkeeping, so the tests can assert the plugin does not fire a burst
// of concurrent requests at a portal that rate-limits them.
let inFlight = 0;
let maxInFlight = 0;
const starts = [];
/** Injects HTTP 429s: { count } responses, optionally with a Retry-After. */
let rateLimit = null;

const resetRequestStats = () => {
  maxInFlight = 0;
  starts.length = 0;
};

globalThis.fetch = async (url, init = {}) => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  starts.push(Date.now());
  try {
    // Never throttles login: a locked-out login has its own test, and mixing the
    // two would only obscure which path is under test.
    if (rateLimit && rateLimit.count > 0 && !String(url).includes('/login')) {
      rateLimit.count -= 1;
      return new Response('', {
        status: 429,
        headers:
          rateLimit.retryAfter === undefined
            ? {}
            : { 'Retry-After': String(rateLimit.retryAfter) },
      });
    }
    return await apiFetch(url, init);
  } finally {
    inFlight -= 1;
  }
};

// ------------------------------------------------------- fake Homebridge host

const logs = [];
const log = Object.assign((...a) => logs.push(['info', a.join(' ')]), {
  info: (m) => logs.push(['info', m]),
  warn: (m) => logs.push(['warn', m]),
  error: (m) => logs.push(['error', m]),
  debug: (m) => logs.push(['debug', m]),
  success: (m) => logs.push(['info', m]),
  log: (l, m) => logs.push([l, m]),
});

const storagePath = mkdtempSync(join(tmpdir(), 'hb-rympro-'));
let activeStoragePath = storagePath;
const registered = [];
const updated = [];
const registeredWithContext = [];
const unregistered = [];
const handlers = {};

const api = {
  hap: { Service, Characteristic, uuid },
  platformAccessory: PlatformAccessory,
  user: { storagePath: () => activeStoragePath },
  versionGreaterOrEqual: () => true,
  on(event, cb) {
    (handlers[event] ??= []).push(cb);
    return this;
  },
  registerPlatform(_pluginName, _platformName, ctor) {
    api._ctor = ctor;
  },
  registerPlatformAccessories: (_p, _pl, accs) => {
    // Snapshot context at registration time: that is what gets cached to disk.
    registeredWithContext.push(...accs.map(a => a.context.meterCount !== undefined));
    registered.push(...accs);
  },
  unregisterPlatformAccessories: (_p, _pl, accs) => unregistered.push(...accs),
  updatePlatformAccessories: (accs) => updated.push(...accs),
};

plugin(api);

// ------------------------------------------------------------------ run tests

/**
 * Waits for the plugin to go quiet. A poll now paces its requests a few hundred
 * milliseconds apart, so a single fixed delay would race it.
 */
const settled = async () => {
  for (let i = 0; i < 100; i += 1) {
    const before = starts.length;
    await new Promise((r) => setTimeout(r, 400));
    if (inFlight === 0 && starts.length === before) {
      return;
    }
  }
  assert.fail('the plugin never stopped making requests');
};
/**
 * Fires didFinishLaunching for the most recently constructed platform only.
 * Every platform in this file registers its own handler on the shared api
 * shim, so firing all of them would start long-finished platforms again.
 */
const launch = async () => {
  handlers.didFinishLaunching?.at(-1)?.();
  await settled();
};

/**
 * Waits for a condition rather than for request quiescence. `settled()` watches
 * for 400ms of no new requests, which a jittered rate-limit backoff can exceed
 * between retries — so it can return while a poll is still mid-ladder.
 */
const waitFor = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
};
const statePath = join(storagePath, '.read-your-meter-pro.json');
let firstDeviceId;

// 1. Refuses to start without credentials.
{
  const p = new api._ctor(log, {}, api);
  assert.equal(p.settings, null);
  assert.ok(
    logs.some(([lvl, m]) => lvl === 'error' && m.includes('"email" and "password" are required')),
    'should log a config error',
  );
  console.log('✓ refuses to start unconfigured');
}

// 2. Happy path.
const platform = new api._ctor(
  log,
  {
    platform: 'ReadYourMeterPro',
    email: 'aran@example.com',
    password: 'correct-horse',
    unit: 'liters',
    dailyThreshold: 500,
    weeklyThreshold: 1500,
    monthlyThreshold: 20000,
    exposeForecast: true,
    exposeTotal: true,
    exposeWeekly: true,
    weeklyWindow: 'sunday',
    pollInterval: 60,
  },
  api,
);

await launch();

assert.equal(registered.length, 1, 'one accessory registered');
const accessory = registered[0];
assert.equal(accessory.context.meterCount, METER_ID);
// Homebridge writes the accessory cache when registerPlatformAccessories is
// called, so context set afterwards would never reach disk.
assert.ok(
  registeredWithContext[0],
  'context.meterCount must be populated before registerPlatformAccessories',
);
console.log(`✓ registered accessory "${accessory.displayName}" with context already set`);

const byName = (name) =>
  accessory.services.find((s) => s.displayName === name) ??
  assert.fail(`missing service: ${name}\n  have: ${accessory.services.map((s) => s.displayName).join(', ')}`);

const lux = (name) => byName(name).getCharacteristic(Characteristic.CurrentAmbientLightLevel).value;

assert.equal(lux('Water Usage Daily'), 734, 'daily 0.734 m³ -> 734 L');
assertLitres(
  lux('Water Usage This Week'),
  expectedWeek(dailyPublished).liters,
  'this week is the published days from the week start to today',
);
assert.equal(lux('Water Usage This Month'), 14200);
assert.equal(lux('Water Monthly Forecast'), 21800);
assert.equal(lux('Water Meter Total'), 812.345, 'total stays in m³');
console.log('✓ light sensors carry the right values');

const leak = (name) => byName(name).getCharacteristic(Characteristic.LeakDetected).value;
assert.equal(leak('Water Daily Alert'), 1, '734 L is over the 500 L daily threshold');
assert.equal(leak('Water Monthly Alert'), 0, '14200 L is under the 20000 L monthly threshold');
assert.equal(
  leak('Water Weekly Alert'),
  expectedWeek(dailyPublished).liters >= 1500 ? 1 : 0,
  'the weekly alert follows the weekly total against its 1500 L threshold',
);
console.log('✓ leak sensors trip on threshold, not before');

assert.equal(
  byName('Water Usage Daily').getCharacteristic(Characteristic.StatusFault).value,
  Characteristic.StatusFault.NO_FAULT,
);

const info = accessory.getService(Service.AccessoryInformation);
assert.equal(
  info.getCharacteristic(Characteristic.SerialNumber).value,
  METER_SERIAL,
  'serial should be the physical meterId, not the meterCount',
);
console.log('✓ accessory information uses the physical meter serial');

// HomeKit silently refuses to add accessories whose Name characteristic starts
// or ends with punctuation, or contains symbols like "³".
{
  const valid = /^[A-Za-z0-9][A-Za-z0-9 ']*[A-Za-z0-9]$/;
  for (const service of accessory.services) {
    const name = service.getCharacteristic(Characteristic.Name).value;
    assert.match(String(name), valid, `service name rejected by HomeKit: "${name}"`);
  }
  assert.match(String(accessory.displayName), valid);
  console.log('✓ every service name is HomeKit-legal');
}

// 2b. A null daily reading means "not published yet", not zero.
{
  dailyIsNull = true;
  await platform.poll();
  assert.equal(lux('Water Usage Daily'), 734, 'a null reading must not overwrite the last known value');
  assert.equal(leak('Water Daily Alert'), 1, 'a null reading must not clear a tripped alert');
  dailyIsNull = false;
  await platform.poll();
  assert.equal(lux('Water Usage Daily'), 734);
  console.log('✓ null daily reading is held, not reported as zero');
}

// 2c. Some accounts only get a day's figure after that day has ended, so today
// is null around the clock. Asking about today alone finds nothing on those
// accounts and the sensor never leaves HomeKit's 0.0001 floor; the most recent
// published day has to be used instead.
{
  // The shape a real account returned: today and yesterday both null, the
  // newest figure two days back.
  dailyPublished = { 0: null, 1: null, 2: 0.6, 3: 0.498 };
  await platform.poll();
  assert.equal(
    lux('Water Usage Daily'),
    600,
    'a two-day lag must fall back to the newest published day, not sit at the lux floor',
  );
  assert.equal(leak('Water Daily Alert'), 1, '600 L is over the 500 L daily threshold');

  // A gap wider than the lookback window is genuinely stale, and holding the
  // last value beats presenting consumption from another week as current.
  dailyPublished = { 9: 0.9 };
  await platform.poll();
  assert.equal(lux('Water Usage Daily'), 600, 'a figure older than the window must not be adopted');

  // Once today lands it wins, even though older days are published too.
  dailyPublished = { 0: 0.734, 1: 0.6 };
  await platform.poll();
  assert.equal(lux('Water Usage Daily'), 734, "today's figure must win over an earlier day");
  console.log('✓ daily falls back to the newest published day within the window');
}

// 2d. Weekly is the current calendar week to date, summed out of the same window
// the daily figure comes from — no extra requests.
{
  const before = calls.length;
  // Every day of the widest possible week is published here, plus one day that
  // can never be in it: the week starts at most six days back, so offset 7 is
  // always outside, and counting it would mean a rolling seven days instead.
  dailyPublished = { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4, 4: 0.5, 5: 0.6, 6: 0.7, 7: 9.9 };
  await platform.poll();

  const week = expectedWeek(dailyPublished);
  assertLitres(lux('Water Usage This Week'), week.liters, 'the week so far');
  assert.ok(
    lux('Water Usage This Week') < 3000,
    'the 9.9 m³ from eight days back leaked into the week: that is a rolling window, not a week',
  );
  assert.equal(
    calls.slice(before).filter((c) => c.includes('/consumption/daily/')).length,
    1,
    'the weekly figure must reuse the daily window rather than fetch its own',
  );
  assert.equal(
    leak('Water Weekly Alert'),
    week.liters >= 1500 ? 1 : 0,
    'the weekly alert trips on the 1500 L threshold',
  );
  console.log(
    `✓ weekly sums the ${week.counted} published day(s) of the current week (${Math.round(week.liters)} L)`,
  );

  // A week with nothing published is unknown, not zero. In the first days of a
  // week that is every day of it, and a zero there would both flash an empty
  // week in the Home app and clear an alert that is still standing.
  const heldWeek = lux('Water Usage This Week');
  const heldAlert = leak('Water Weekly Alert');
  dailyPublished = { 7: 9.9 };
  await platform.poll();
  assert.equal(
    lux('Water Usage This Week'),
    heldWeek,
    'a week with no published day must hold its last total, not report zero',
  );
  assert.equal(leak('Water Weekly Alert'), heldAlert, 'nor may it move the weekly alert');
  console.log('✓ a week with nothing published holds instead of reporting zero');

  // Both start days, on fixed dates rather than on whatever weekday the suite
  // happens to run: 2026-08-20 is a Thursday, 2026-08-16 a Sunday.
  const { weekStart } = await import('../dist/rympro.js');
  assert.equal(weekStart('2026-08-20', 0), '2026-08-16');
  assert.equal(weekStart('2026-08-20', 1), '2026-08-17');
  assert.equal(weekStart('2026-08-16', 0), '2026-08-16', 'a Sunday starts its own Sunday week');
  assert.equal(weekStart('2026-08-16', 1), '2026-08-10', 'a Sunday ends the Monday week before it');
  // Month, year and DST boundaries: Israel moves the clocks on 2026-03-27.
  assert.equal(weekStart('2026-04-01', 0), '2026-03-29');
  assert.equal(weekStart('2026-04-01', 1), '2026-03-30');
  assert.equal(weekStart('2026-01-01', 0), '2025-12-28');
  assert.equal(weekStart('2026-01-01', 1), '2025-12-29');
  console.log('✓ week start resolves for Sunday and Monday across month, year and DST edges');

  dailyPublished = { 0: 0.734, 1: 0.512, 2: 0.498, 3: 0.501 };
  await platform.poll();
}

// 2e. `weeklyWindow: rolling` covers the seven days ending today instead of the
// calendar week, so the total does not depend on the weekday and does not reset.
{
  dailyPublished = { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4, 4: 0.5, 5: 0.6, 6: 0.7, 7: 9.9 };
  const rolling = new api._ctor(
    log,
    {
      platform: 'ReadYourMeterPro',
      email: 'aran@example.com',
      password: 'correct-horse',
      unit: 'liters',
      dailyThreshold: 500,
      weeklyThreshold: 1500,
      monthlyThreshold: 20000,
      exposeForecast: true,
      exposeTotal: true,
      exposeWeekly: true,
      weeklyWindow: 'rolling',
    },
    api,
  );
  rolling.configureAccessory(registered[0]);
  await launch();

  // Offsets 0..6 are the window; the 9.9 m³ at offset 7 is the eighth day back
  // and stays out of it, so a wrong boundary here is unmissable.
  assertLitres(lux('Water Usage This Week'), 2800, 'the seven days ending today');
  assert.equal(leak('Water Weekly Alert'), 1, '2800 L is over the 1500 L threshold');
  console.log('✓ the rolling window sums the last 7 days, whatever the weekday');

  // The Homebridge UI writes an empty value for a dropdown left alone, and the
  // config can be hand-edited to anything at all; both mean the default week.
  for (const value of ['', undefined, 'nonsense']) {
    const other = new api._ctor(
      log,
      {
        platform: 'ReadYourMeterPro',
        email: 'aran@example.com',
        password: 'correct-horse',
        weeklyWindow: value,
      },
      api,
    );
    assert.equal(
      other.settings.weeklyWindow,
      'sunday',
      `weeklyWindow: ${JSON.stringify(value)} must fall back to the Sunday calendar week`,
    );
  }
  console.log('✓ an unset or unrecognised weeklyWindow falls back to the Sunday week');

  dailyPublished = { 0: 0.734, 1: 0.512, 2: 0.498, 3: 0.501 };
  await platform.poll();
}

// 2f. A poll must trickle its requests rather than burst them: the portal
// rate-limits bursts, and a 429 on the first request costs the whole poll.
{
  resetRequestStats();
  await platform.poll();
  assert.equal(maxInFlight, 1, 'requests must be issued one at a time');
  assert.ok(starts.length >= 4, `expected one request per endpoint, got ${starts.length}`);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(
    Math.min(...gaps) >= 200,
    `requests were not paced apart: gaps of ${gaps.join(', ')}ms`,
  );
  console.log(`✓ poll issues ${starts.length} requests serially, ${Math.min(...gaps)}ms+ apart`);
}

// 3. Zero consumption must floor at 0.0001, not throw a HAP warning.
{
  const { clampLux } = await import('../dist/meterAccessory.js');
  assert.equal(clampLux(0), 0.0001);
  assert.equal(clampLux(1e9), 100000);
  assert.equal(clampLux(NaN), 0.0001);
  const c = new Characteristic('t', uuid.generate('t'), {
    format: 'float',
    perms: ['pr'],
    minValue: 0.0001,
    maxValue: 100000,
  });
  c.updateValue(clampLux(0));
  assert.equal(c.value, 0.0001, 'HAP must accept the floored value unmodified');
  console.log('✓ lux clamping keeps HAP happy at both ends');
}

// 4. Expired token triggers exactly one silent re-login.
{
  const before = loginCount;
  const logMark = logs.length;
  expireNextGet = true;
  calls.length = 0;
  await platform.poll();
  assert.equal(loginCount, before + 1, 'exactly one re-login');
  assert.equal(lux('Water Usage Daily'), 734, 'data still refreshed after re-auth');
  assert.ok(
    !logs.slice(logMark).some(([lvl]) => lvl === 'error' || lvl === 'warn'),
    'a token refresh should be silent, not a warning',
  );
  console.log('✓ recovers from an expired token');
}

// 4b. A single 429 is retried inside the same poll, so a burst of throttling
// does not cost an hour of stale readings.
{
  const logMark = logs.length;
  resetRequestStats();
  rateLimit = { count: 1 };
  await platform.poll();
  rateLimit = null;

  assert.equal(lux('Water Usage Daily'), 734, 'the retried poll must still deliver data');
  assert.equal(
    byName('Water Usage Daily').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.NO_FAULT,
    'a 429 that was retried successfully must not fault the sensors',
  );
  const noisy = logs.slice(logMark).filter(([lvl]) => lvl === 'warn' || lvl === 'error');
  assert.deepEqual(noisy, [], 'a recovered 429 must not be logged as a problem');
  assert.ok(
    logs.slice(logMark).some(([lvl, m]) => lvl === 'debug' && m.includes('Rate limited')),
    'the retry should still be visible in the debug log',
  );
  // First rung of the ladder is 2s, jittered by +/-25%. Measured between the
  // throttled request and its retry so the inter-request pacing is excluded.
  const backoff = starts[1] - starts[0];
  assert.ok(
    backoff >= 1_400 && backoff <= 3_000,
    `expected a ~2s jittered backoff before the retry, waited ${backoff}ms`,
  );
  console.log(`✓ a 429 is retried in-poll after ${backoff}ms and the poll still succeeds`);
}

// 4c. A Retry-After longer than a poll can sit on ends the poll instead of
// blocking on it; the next poll is a better place to try again.
{
  const logMark = logs.length;
  resetRequestStats();
  rateLimit = { count: 99, retryAfter: 3600 };
  await platform.poll();
  rateLimit = null;

  assert.equal(
    starts.length,
    1,
    `an hour-long Retry-After must not be waited out, made ${starts.length} attempts`,
  );
  assert.ok(
    logs.slice(logMark).some(([lvl, m]) => lvl === 'warn' && m.includes('HTTP 429')),
    'giving up on a 429 should be reported',
  );
  await platform.poll();
  console.log('✓ an over-long Retry-After ends the poll instead of stalling it');
}

// 4d. A 429 that never lets up is given up on after the retry budget rather
// than being retried forever.
{
  resetRequestStats();
  // Retry-After: 0 keeps the test quick while still exercising every rung.
  rateLimit = { count: 99, retryAfter: 0 };
  await platform.poll();
  rateLimit = null;

  assert.equal(starts.length, 4, `expected 1 attempt plus 3 retries, got ${starts.length}`);
  await platform.poll();
  assert.equal(lux('Water Usage Daily'), 734, 'the next poll must recover');
  console.log('✓ a persistent 429 gives up after its retry budget');
}

// 5. Persisted state survives a restart (device id is stable).
{
  const { readFileSync } = await import('node:fs');
  await platform.flushState();
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.match(state.deviceId, /^[0-9a-f-]{36}$/);
  assert.match(state.token, /^token-/);
  firstDeviceId = state.deviceId;
  console.log('✓ device id and token persisted to the Homebridge storage dir');
}

// 6. A one-off failure holds its readings; only a persistent one faults.
{
  const logMark = logs.length;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  await platform.poll();
  assert.equal(
    byName('Water Usage Daily').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.NO_FAULT,
    'a single failed poll must not fault the sensors',
  );
  assert.equal(lux('Water Usage Daily'), 734, 'the last known reading must be held');
  assert.ok(
    logs.slice(logMark).some(([lvl, m]) => lvl === 'warn' && m.includes('failure 1 of 3')),
    'the failure should still be reported, with its count',
  );
  console.log('✓ one failed poll holds its readings instead of faulting');

  await platform.poll();
  await platform.poll();
  globalThis.fetch = realFetch;
  assert.equal(
    byName('Water Usage Daily').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.GENERAL_FAULT,
    'three consecutive failures must surface as a fault',
  );
  assert.equal(byName('Water Usage Daily').getCharacteristic(Characteristic.StatusActive).value, false);
  assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && m.includes('retry on the next poll')));
  console.log('✓ a persistent failure sets StatusFault and keeps polling');

  await platform.poll();
  assert.equal(
    byName('Water Usage Daily').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.NO_FAULT,
  );
  console.log('✓ fault clears on recovery');
}

// 6b. A failed FIRST poll after a restart must still surface a fault on the
// cached accessory, and must retry quickly rather than after a full interval.
{
  const cached = registered[0];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const cold = new api._ctor(
    log,
    {
      platform: 'ReadYourMeterPro',
      email: 'aran@example.com',
      password: 'correct-horse',
      pollInterval: 720,
      dailyThreshold: 500,
    },
    api,
  );
  cold.configureAccessory(cached);
  await launch();
  globalThis.fetch = realFetch;

  const svc = cached.services.find((s) => s.displayName === 'Water Usage Daily');
  assert.equal(
    svc.getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.GENERAL_FAULT,
    'cached accessory must show a fault when the first poll fails',
  );
  assert.ok(cold.timer, 'a retry must be armed');
  // 720 minutes was configured; the cold retry must be far shorter.
  const remaining = cold.timer._idleTimeout;
  assert.ok(
    remaining <= 60_000,
    `cold retry should be <=60s, got ${remaining}ms`,
  );
  cold.timer.close?.();
  clearTimeout(cold.timer);
  console.log('✓ failed first poll faults cached accessories and retries fast');
}

// 6c. A cold start that is being rate-limited must NOT fall back to the 60s
// cold retry. The portal limits logins per account, so retrying every minute
// keeps the limit it is waiting on open.
{
  const realStorage = activeStoragePath;
  activeStoragePath = mkdtempSync(join(tmpdir(), 'hb-rympro-429-'));
  rateLimit = { count: 99, retryAfter: 0 };
  const limited = new api._ctor(
    log,
    {
      platform: 'ReadYourMeterPro',
      email: 'aran@example.com',
      password: 'correct-horse',
      pollInterval: 720,
    },
    api,
  );
  await launch();
  // The retry ladder outlasts settled()'s quiet window, so wait for the poll to
  // actually finish and arm its next attempt.
  await waitFor(() => limited.timer, 'the rate-limited poll to arm its retry');
  rateLimit = null;
  activeStoragePath = realStorage;

  const delay = limited.timer._idleTimeout;
  assert.ok(
    delay >= 15 * 60_000,
    `a rate-limited cold start must back off >=15min, got ${Math.round(delay / 1000)}s`,
  );
  assert.ok(
    logs.some(([level, m]) => level === 'warn' && /rate-limiting this account/.test(m)),
    'the long backoff must be explained in the log, not silent',
  );
  limited.timer.close?.();
  clearTimeout(limited.timer);
  console.log(`✓ a rate-limited cold start backs off ${Math.round(delay / 60_000)}min, not 60s`);
}

// 7. Bad credentials stop the poll loop rather than hammering the portal.
{
  // Fresh storage dir: no cached token, so the plugin must actually log in.
  activeStoragePath = mkdtempSync(join(tmpdir(), 'hb-rympro-bad-'));
  const bad = new api._ctor(
    log,
    { platform: 'ReadYourMeterPro', email: 'aran@example.com', password: 'wrong' },
    api,
  );
  await launch();
  assert.ok(
    logs.some(([lvl, m]) => lvl === 'error' && m.includes('Polling stopped')),
    'should stop and say so',
  );
  assert.equal(bad.timer, null, 'no retry timer armed');
  activeStoragePath = storagePath;
  console.log('✓ rejected credentials stop the loop with a clear error');
}

// 7b. A rename in the Home app survives a restart.
{
  const cached = registered[0];
  const configured = (acc) =>
    acc.services
      .find((s) => s.subtype === 'daily')
      .getCharacteristic(Characteristic.ConfiguredName);

  // What the Home app does when the user renames the tile.
  await configured(cached).handleSetRequest('Garden Tap Today');
  assert.equal(
    cached.context.names.daily,
    'Garden Tap Today',
    'a rename must be recorded in the accessory context, which is what gets cached',
  );
  assert.ok(updated.includes(cached), 'the context change must be flushed to the accessory cache');

  const renamed = new api._ctor(
    log,
    {
      platform: 'ReadYourMeterPro',
      email: 'aran@example.com',
      password: 'correct-horse',
      dailyThreshold: 500,
    },
    api,
  );
  renamed.configureAccessory(cached);
  await launch();
  assert.equal(
    configured(cached).value,
    'Garden Tap Today',
    'a restart must not reset the name the user chose',
  );
  console.log('✓ Home app renames survive a restart');

  // A name pinned in config.json is the documented escape hatch, so it wins.
  const pinned = new api._ctor(
    log,
    {
      platform: 'ReadYourMeterPro',
      email: 'aran@example.com',
      password: 'correct-horse',
      dailyThreshold: 500,
      nameDaily: 'Water Used Today',
    },
    api,
  );
  pinned.configureAccessory(cached);
  await launch();
  assert.equal(configured(cached).value, 'Water Used Today', 'config must override a rename');
  console.log('✓ a name pinned in config wins over a Home app rename');

  // An invalid name is refused rather than passed to HomeKit, which would
  // silently drop the whole accessory.
  const logMark = logs.length;
  const bogus = new api._ctor(
    log,
    {
      platform: 'ReadYourMeterPro',
      email: 'aran@example.com',
      password: 'correct-horse',
      nameDaily: 'Water (m³)',
    },
    api,
  );
  assert.equal(bogus.settings.nameOverrides.daily, undefined);
  assert.ok(
    logs.slice(logMark).some(([lvl, m]) => lvl === 'warn' && m.includes('not a name HomeKit accepts')),
    'an unusable name must be reported',
  );
  console.log('✓ names HomeKit would reject are ignored with a warning');

  // Reset for the teardown test below: drop the pinned name and the rename.
  delete cached.context.names.daily;
}

// 7c. The case name adoption exists for: an install that predates name
// persistence has the user's rename on the restored service and nothing in the
// accessory context, and must keep it rather than be reset one last time. The
// current default is not adopted, so changing a default is not a no-op.
{
  const cached = registered[0];
  const daily = () => cached.services.find((s) => s.subtype === 'daily');
  const restart = async (config) => {
    const p = new api._ctor(
      log,
      { platform: 'ReadYourMeterPro', email: 'aran@example.com', password: 'correct-horse', ...config },
      api,
    );
    p.configureAccessory(cached);
    await launch();
  };

  delete cached.context.names.daily;
  daily().updateCharacteristic(Characteristic.ConfiguredName, 'Water Usage Daily');
  await restart({});
  assert.equal(
    cached.context.names.daily,
    undefined,
    'the shipped default must not be recorded as a name the user chose',
  );

  delete cached.context.names.daily;
  daily().updateCharacteristic(Characteristic.ConfiguredName, 'Kitchen Water');
  await restart({});
  assert.equal(
    cached.context.names.daily,
    'Kitchen Water',
    'a rename made before name persistence existed must be adopted',
  );
  assert.equal(daily().getCharacteristic(Characteristic.ConfiguredName).value, 'Kitchen Water');
  console.log('✓ a rename predating name persistence is adopted on upgrade');

  delete cached.context.names.daily;
  daily().updateCharacteristic(Characteristic.ConfiguredName, 'Water Usage Daily');
}

// 8. Every sensor can be switched off, and de-configured ones are removed.
{
  const cached = registered[0];
  const p2 = new api._ctor(
    log,
    {
      platform: 'ReadYourMeterPro',
      email: 'aran@example.com',
      password: 'correct-horse',
      dailyThreshold: 0,
      monthlyThreshold: 0,
      exposeMonthly: false,
      exposeForecast: false,
      exposeTotal: false,
    },
    api,
  );
  p2.configureAccessory(cached);
  await launch();
  const names = cached.services.map((s) => s.displayName);
  assert.ok(!names.includes('Water Daily Alert'), `stale service kept: ${names.join(', ')}`);
  assert.ok(!names.includes('Water Monthly Forecast'));
  assert.ok(!names.includes('Water Usage This Month'), 'the monthly sensor must be removable');
  assert.ok(names.includes('Water Usage Daily'));
  console.log('✓ de-configured services are cleaned up, cached accessory reused');
  assert.equal(registered.length, 1, 'no duplicate accessory registered');

  // A threshold of 0 is the only off switch for an alert, and it must win: an
  // alert with no threshold would report a leak on every single poll.
  assert.equal(p2.settings.expose['daily-alert'], false);
  assert.equal(p2.settings.expose['monthly-alert'], false);
  console.log('✓ a threshold of 0 keeps the alert sensor away entirely');

  await p2.flushState();
  const { readFileSync } = await import('node:fs');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.deviceId, firstDeviceId, 'device id must survive a restart');
  console.log('✓ device id is stable across restarts');
}

console.log('\nAll smoke tests passed.');
