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
let dailyIsNull = false;

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
    if (dailyIsNull) {
      // Exactly what the portal returns before today's reading is published.
      return json([
        {
          meterCount: METER_ID,
          consDate: '2026-08-19T00:00:00',
          cons: null,
          estimationType: 0,
          commonCons: 0,
          meterStatusDesc: '-',
        },
      ]);
    }
    return json([
      {
        meterCount: METER_ID,
        consDate: '2026-08-19T00:00:00',
        cons: 0.734,
        estimationType: 1,
        commonCons: 0,
        meterStatusDesc: '-',
      },
    ]);
  }
  if (path.startsWith(`/consumption/monthly/${METER_ID}/`)) {
    return json([
      {
        meterCount: METER_ID,
        consDate: '2026-08-01T00:00:00',
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
    monthlyThreshold: 20000,
    exposeForecast: true,
    exposeTotal: true,
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

assert.equal(lux('Water Usage Today'), 734, 'daily 0.734 m³ -> 734 L');
assert.equal(lux('Water Usage This Month'), 14200);
assert.equal(lux('Water Monthly Forecast'), 21800);
assert.equal(lux('Water Meter Total'), 812.345, 'total stays in m³');
console.log('✓ light sensors carry the right values');

const leak = (name) => byName(name).getCharacteristic(Characteristic.LeakDetected).value;
assert.equal(leak('Water Daily Alert'), 1, '734 L is over the 500 L daily threshold');
assert.equal(leak('Water Monthly Alert'), 0, '14200 L is under the 20000 L monthly threshold');
console.log('✓ leak sensors trip on threshold, not before');

assert.equal(
  byName('Water Usage Today').getCharacteristic(Characteristic.StatusFault).value,
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
  assert.equal(lux('Water Usage Today'), 734, 'a null reading must not overwrite the last known value');
  assert.equal(leak('Water Daily Alert'), 1, 'a null reading must not clear a tripped alert');
  dailyIsNull = false;
  await platform.poll();
  assert.equal(lux('Water Usage Today'), 734);
  console.log('✓ null daily reading is held, not reported as zero');
}

// 2c. A poll must trickle its requests rather than burst them: the portal
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
  assert.equal(lux('Water Usage Today'), 734, 'data still refreshed after re-auth');
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

  assert.equal(lux('Water Usage Today'), 734, 'the retried poll must still deliver data');
  assert.equal(
    byName('Water Usage Today').getCharacteristic(Characteristic.StatusFault).value,
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
  assert.equal(lux('Water Usage Today'), 734, 'the next poll must recover');
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
    byName('Water Usage Today').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.NO_FAULT,
    'a single failed poll must not fault the sensors',
  );
  assert.equal(lux('Water Usage Today'), 734, 'the last known reading must be held');
  assert.ok(
    logs.slice(logMark).some(([lvl, m]) => lvl === 'warn' && m.includes('failure 1 of 3')),
    'the failure should still be reported, with its count',
  );
  console.log('✓ one failed poll holds its readings instead of faulting');

  await platform.poll();
  await platform.poll();
  globalThis.fetch = realFetch;
  assert.equal(
    byName('Water Usage Today').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.GENERAL_FAULT,
    'three consecutive failures must surface as a fault',
  );
  assert.equal(byName('Water Usage Today').getCharacteristic(Characteristic.StatusActive).value, false);
  assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && m.includes('retry on the next poll')));
  console.log('✓ a persistent failure sets StatusFault and keeps polling');

  await platform.poll();
  assert.equal(
    byName('Water Usage Today').getCharacteristic(Characteristic.StatusFault).value,
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

  const svc = cached.services.find((s) => s.displayName === 'Water Usage Today');
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
  assert.ok(names.includes('Water Usage Today'));
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
