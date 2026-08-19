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
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.RYM_BASE_URL ?? 'https://eu-customerportal-api.harmonyencoremdm.com';
const email = process.env.RYM_EMAIL;
const password = process.env.RYM_PW;

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

const today = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

async function main() {
  const raw = {};

  process.stdout.write('Logging in... ');
  const loginRes = await fetch(`${BASE_URL}/consumer/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pw: password, deviceId: `probe-${randomUUID()}` }),
  });
  const login = await loginRes.json();
  if (!login.token) {
    console.log('failed');
    console.error(`  HTTP ${loginRes.status}, code=${login.code}, error=${login.error}`);
    process.exit(1);
  }
  console.log('ok');
  const headers = { 'Content-Type': 'application/json', 'x-access-token': login.token };

  const get = async (label, path) => {
    const res = await fetch(`${BASE_URL}${path}`, { headers });
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
