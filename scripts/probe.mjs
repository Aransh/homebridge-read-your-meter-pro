#!/usr/bin/env node
/**
 * Standalone probe for the Read Your Meter Pro API.
 *
 * Dumps the raw shape of every endpoint the plugin uses, so field names can be
 * verified against a real account. Does not depend on the built plugin.
 *
 *   RYM_EMAIL=you@example.com RYM_PW='...' node scripts/probe.mjs
 *
 * Two outputs:
 *   - stdout: a redacted summary, safe to paste into an issue or a chat.
 *   - ./probe-output.json: the full unredacted response, for your eyes only.
 *     Gitignored. Delete it when you are done.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.RYM_BASE_URL ?? 'https://eu-customerportal-api.harmonyencoremdm.com';
const email = process.env.RYM_EMAIL;
const password = process.env.RYM_PW;

/**
 * Where the probe keeps its own device id and session token (mode 0600,
 * gitignored). Both are reused across runs: the portal registers a device per
 * id and rate-limits logins per user, so minting a fresh id every run — which
 * this script used to do — burns through that limit and locks the account out of
 * logging in at all, plugin included.
 */
const PROBE_STATE_FILE = '.probe-state.json';

/**
 * Optionally, the running plugin's own state file
 * (`<homebridge storage>/.read-your-meter-pro.json`), read to borrow its device
 * id and token so the probe needs no login of its own. Only ever read, never
 * written: clobbering it would take the running plugin down with it.
 */
const PLUGIN_STATE_FILE = process.env.RYM_STATE_FILE;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Device id and token to try, preferring the plugin's over the probe's own. */
function loadState() {
  if (PLUGIN_STATE_FILE) {
    const state = readJson(PLUGIN_STATE_FILE);
    if (state?.deviceId) {
      console.log(`Reusing the plugin's device id from ${PLUGIN_STATE_FILE}`);
      return { ...state, borrowed: true };
    }
    console.error(`Could not read a deviceId from ${PLUGIN_STATE_FILE}; falling back.`);
  }
  const own = readJson(PROBE_STATE_FILE);
  if (own?.deviceId) {
    return { ...own, borrowed: false };
  }
  return { deviceId: `probe-${randomUUID()}`, token: undefined, borrowed: false };
}

const state = loadState();

/** Persists the probe's own device id and token. Never touches the plugin's. */
function saveState(token) {
  if (state.borrowed) {
    return;
  }
  writeFileSync(PROBE_STATE_FILE, JSON.stringify({ deviceId: state.deviceId, token }), {
    mode: 0o600,
  });
}

if (!email || !password) {
  console.error('Set RYM_EMAIL and RYM_PW. Use a leading space or a subshell to keep');
  console.error('the password out of your shell history, e.g.:');
  console.error("  RYM_EMAIL=you@example.com RYM_PW='...' node scripts/probe.mjs");
  process.exit(2);
}

/** Keys whose values are masked in the printed summary. */
const SENSITIVE =
  /(email|mail|phone|mobile|address|street|city|zip|postal|firstname|lastname|fullname|username|token|password|^pw$|userid|customerid|accountnumber|^account$|^id$)/i;

function redact(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (SENSITIVE.test(key)) {
    return `<${typeof value}:redacted:len=${String(value).length}>`;
  }
  return value;
}

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const today = ymd(new Date());

/** `days` before today, as YYYY-MM-DD. */
const daysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return ymd(d);
};

/**
 * How far back the window probe looks. The portal publishes a day's `cons` some
 * time after that day starts — sometimes after it ends — and the only way to
 * know the lag on a given account is to ask for several days and see which ones
 * came back populated.
 */
const WINDOW_DAYS = 7;

/** Explains a 429 rather than leaving the caller to guess, and stops. */
function bailOnRateLimit(response, what) {
  const retryAfter = response.headers.get('retry-after');
  console.log('rate limited');
  console.error(`\n  HTTP 429 on ${what}: the portal is refusing further requests for this account.`);
  console.error(
    retryAfter
      ? `  It asked us to wait ${retryAfter}s. Try again after that.`
      : '  It sent no Retry-After. These limits usually clear within an hour.',
  );
  console.error('\n  Two things burn through the login limit:');
  console.error('   - Probe runs before this fix, which registered a new device each time.');
  console.error('   - A restarted plugin with no cached token, which retries login every minute.');
  console.error('\n  To probe without logging in at all, borrow the running plugin\'s session:');
  console.error('    RYM_STATE_FILE=/path/to/homebridge/.read-your-meter-pro.json \\');
  console.error('      RYM_EMAIL=... RYM_PW=... npm run probe');
  process.exit(3);
}

/** Confirms a cached token still works, so the run can skip logging in. */
async function tokenIsValid(token) {
  const res = await fetch(`${BASE_URL}/consumer/me`, {
    headers: { 'Content-Type': 'application/json', 'x-access-token': token },
  });
  if (res.status === 429) {
    bailOnRateLimit(res, '/consumer/me');
  }
  return res.ok;
}

async function main() {
  const raw = {};

  let token = state.token;
  if (token) {
    process.stdout.write('Trying the cached session... ');
    if (await tokenIsValid(token)) {
      console.log('ok (no login needed)');
    } else {
      console.log('expired');
      token = undefined;
    }
  }

  if (!token) {
    process.stdout.write(`Logging in (device ${state.deviceId.slice(0, 12)}...)... `);
    const loginRes = await fetch(`${BASE_URL}/consumer/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pw: password, deviceId: state.deviceId }),
    });
    if (loginRes.status === 429) {
      bailOnRateLimit(loginRes, '/consumer/login');
    }
    const login = await loginRes.json();
    if (!login.token) {
      console.log('failed');
      if (login.code === 429 || /rate exceeded/i.test(String(login.error))) {
        bailOnRateLimit(loginRes, '/consumer/login');
      }
      console.error(`  HTTP ${loginRes.status}, code=${login.code}, error=${login.error}`);
      process.exit(1);
    }
    console.log('ok');
    token = login.token;
    // Cached so the next run needs no login, which is the whole point.
    saveState(token);
  }

  const headers = { 'Content-Type': 'application/json', 'x-access-token': token };

  const get = async (label, path) => {
    // Spaced like the plugin's own requests: a burst is what trips the limiter.
    await new Promise((r) => setTimeout(r, 250));
    const res = await fetch(`${BASE_URL}${path}`, { headers });
    if (res.status === 429) {
      bailOnRateLimit(res, `GET ${path}`);
    }
    const body = res.ok ? await res.json() : await res.text();
    raw[label] = { status: res.status, body };
    console.log(`\n=== ${label}  (GET ${path}) -> HTTP ${res.status}`);
    console.log(JSON.stringify(redact(body), null, 2));
    return body;
  };

  await get('account_info', '/consumer/me');
  const meters = await get('last_read', '/consumption/last-read');

  const meterIds = Array.isArray(meters)
    ? meters.map((m) => m.meterCount).filter((m) => m !== undefined)
    : [];

  if (meterIds.length === 0) {
    console.log('\nNo meterCount found on /consumption/last-read — cannot probe consumption.');
  }

  for (const id of meterIds) {
    await get(`forecast_${id}`, `/consumption/forecast/${id}`);
    await get(`daily_${id}`, `/consumption/daily/${id}/${today}/${today}`);
    await get(`monthly_${id}`, `/consumption/monthly/${id}/${today}/${today}`);

    // The same endpoint over a window. Which days come back with a non-null
    // `cons` is what decides how far the plugin has to look back to find a
    // figure, so it is printed as a table rather than left in the JSON dump.
    const window = await get(
      `daily_window_${id}`,
      `/consumption/daily/${id}/${daysAgo(WINDOW_DAYS)}/${today}`,
    );
    if (Array.isArray(window)) {
      console.log(`\n--- daily window for meter ${id} (published? by day) ---`);
      for (const row of window) {
        const date = String(row?.consDate ?? '?').slice(0, 10);
        const cons = row?.cons;
        const state = cons === null || cons === undefined ? 'null (not published)' : `${cons} m³`;
        console.log(`  ${date}  ${state}`);
      }
      console.log(`  ${window.length} row(s) for a ${WINDOW_DAYS + 1}-day range`);
    }
  }

  writeFileSync('probe-output.json', JSON.stringify(raw, null, 2), { mode: 0o600 });

  console.log('\n--- key inventory for last_read ---');
  if (Array.isArray(meters) && meters.length > 0) {
    for (const [k, v] of Object.entries(meters[0])) {
      console.log(`  ${k.padEnd(24)} ${typeof v}`);
    }
  }

  console.log('\nFull unredacted output written to ./probe-output.json (mode 0600).');
  console.log('The summary above is safe to share. Delete probe-output.json when done.');
}

main().catch((error) => {
  console.error(`\nProbe failed: ${error?.message ?? error}`);
  process.exit(1);
});
