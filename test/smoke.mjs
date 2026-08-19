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

globalThis.fetch = async (url, init = {}) => {
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

const settled = () => new Promise((r) => setTimeout(r, 60));
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

for (const cb of handlers.didFinishLaunching ?? []) {
  cb();
}
await settled();

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

assert.equal(lux('Water Today'), 734, 'daily 0.734 m³ -> 734 L');
assert.equal(lux('Water This Month'), 14200);
assert.equal(lux('Water Forecast'), 21800);
assert.equal(lux('Water Meter Total'), 812.345, 'total stays in m³');
console.log('✓ light sensors carry the right values');

const leak = (name) => byName(name).getCharacteristic(Characteristic.LeakDetected).value;
assert.equal(leak('Water Daily Alert'), 1, '734 L is over the 500 L daily threshold');
assert.equal(leak('Water Monthly Alert'), 0, '14200 L is under the 20000 L monthly threshold');
console.log('✓ leak sensors trip on threshold, not before');

assert.equal(
  byName('Water Today').getCharacteristic(Characteristic.StatusFault).value,
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
  assert.equal(lux('Water Today'), 734, 'a null reading must not overwrite the last known value');
  assert.equal(leak('Water Daily Alert'), 1, 'a null reading must not clear a tripped alert');
  dailyIsNull = false;
  await platform.poll();
  assert.equal(lux('Water Today'), 734);
  console.log('✓ null daily reading is held, not reported as zero');
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
  assert.equal(lux('Water Today'), 734, 'data still refreshed after re-auth');
  assert.ok(
    !logs.slice(logMark).some(([lvl]) => lvl === 'error' || lvl === 'warn'),
    'a token refresh should be silent, not a warning',
  );
  console.log('✓ recovers from an expired token');
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

// 6. Network failure faults the services instead of crashing.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await platform.poll();
  globalThis.fetch = realFetch;
  assert.equal(
    byName('Water Today').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.GENERAL_FAULT,
  );
  assert.equal(byName('Water Today').getCharacteristic(Characteristic.StatusActive).value, false);
  assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && m.includes('retry on the next poll')));
  console.log('✓ transient failure sets StatusFault and keeps polling');

  await platform.poll();
  assert.equal(
    byName('Water Today').getCharacteristic(Characteristic.StatusFault).value,
    Characteristic.StatusFault.NO_FAULT,
  );
  console.log('✓ fault clears on recovery');
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
  for (const cb of handlers.didFinishLaunching ?? []) {
    cb();
  }
  await settled();
  assert.ok(
    logs.some(([lvl, m]) => lvl === 'error' && m.includes('Polling stopped')),
    'should stop and say so',
  );
  assert.equal(bad.timer, null, 'no retry timer armed');
  activeStoragePath = storagePath;
  console.log('✓ rejected credentials stop the loop with a clear error');
}

// 8. Turning a threshold off removes the service on the next start.
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
      exposeForecast: false,
      exposeTotal: false,
    },
    api,
  );
  p2.configureAccessory(cached);
  for (const cb of handlers.didFinishLaunching ?? []) {
    cb();
  }
  await settled();
  const names = cached.services.map((s) => s.displayName);
  assert.ok(!names.includes('Water Daily Alert'), `stale service kept: ${names.join(', ')}`);
  assert.ok(!names.includes('Water Forecast'));
  assert.ok(names.includes('Water Today'));
  console.log('✓ de-configured services are cleaned up, cached accessory reused');
  assert.equal(registered.length, 1, 'no duplicate accessory registered');

  await p2.flushState();
  const { readFileSync } = await import('node:fs');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.deviceId, firstDeviceId, 'device id must survive a restart');
  console.log('✓ device id is stable across restarts');
}

console.log('\nAll smoke tests passed.');
