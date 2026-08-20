# homebridge-read-your-meter-pro

Exposes water consumption from the Israeli [Read Your Meter Pro](https://rym-pro.com)
portal (ARAD meters) in HomeKit.

Unofficial, and not affiliated with Arad Group or any water corporation.

## Read this before installing

**HomeKit has no water-consumption service.** There is no accessory type in the
HomeKit Accessory Protocol for volume or metering, so there is no honest way to
show "0.734 m³" in the Home app. This plugin works around that:

| What you get | How | Default name | On by default |
| --- | --- | --- | --- |
| Today's consumption | Light sensor | `Water Usage Today` | yes |
| This month's consumption | Light sensor | `Water Usage This Month` | yes |
| Month-end forecast | Light sensor | `Water Monthly Forecast` | yes |
| Cumulative meter reading | Light sensor, always m³ | `Water Meter Total` | no |
| Daily threshold exceeded | Leak sensor | `Water Daily Alert` | when a threshold is set |
| Monthly threshold exceeded | Leak sensor | `Water Monthly Alert` | when a threshold is set |

Light sensors show up in the Home app as a number and the word `lux` — `734 lux`
means 734 litres. Every sensor can be switched off individually, and every name
can be changed, either in the Home app or in config.json.

The word "lux" is wrong and there is nothing to be done about it. The number is
correct. Default names carry no unit, because HomeKit rejects names that end in
punctuation or contain symbols like `³`.

### Why a light sensor?

This is a deliberate compromise, not an oversight. HAP defines `Valve`,
`Faucet`, `IrrigationSystem` and `LeakSensor`, but nothing that carries a volume
or a meter reading, and Apple provides no mechanism for a custom unit that the
Home app will render. The alternatives were:

- **Eve custom characteristics.** Spec-correct, but the values appear only in
  the Eve app and never in Apple Home, and the `E863F131` encoding is
  reverse-engineered rather than documented.
- **Show nothing numeric at all.** Leak sensors only. Honest, but users
  reasonably want to glance at a number.
- **A light sensor carrying the value.** Works in every HomeKit client, no
  reverse engineering, at the cost of a wrong unit label.

The third option loses one label and keeps everything else, so that is what this
plugin does. The leak sensors remain the functional core — they are a real
sensor type, so notifications and automations behave correctly.

The **leak sensors are the point**. They are a real HomeKit sensor type, so you
get push notifications and automation triggers for free — "notify me if today's
usage passes 500 L" is a decent leak detector for a house. The light sensors are
there so you can glance at a number; if you want graphs, put the data in
Prometheus/InfluxDB instead, not HomeKit.

## Requirements

- An account at [rym-pro.com](https://rym-pro.com). Registration fails if your
  meter is not an ARAD unit or your water corporation has not migrated to the
  Pro portal — verify you can log in on the web before installing.
- Homebridge v1.8+ or v2.x, Node.js 22 or 24.
- No runtime dependencies, so installation is a single request — which matters
  on a Raspberry Pi, where npm's per-dependency fetching is slow and failure-prone.

## Installation

```bash
npm install -g homebridge-read-your-meter-pro
```

Or search for "Read Your Meter Pro" in the Homebridge UI plugin browser.

## Configuration

Use the Homebridge UI settings form, or add to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "ReadYourMeterPro",
      "name": "Read Your Meter Pro",
      "email": "you@example.com",
      "password": "your-portal-password",
      "unit": "liters",
      "pollInterval": 60,
      "dailyThreshold": 800,
      "monthlyThreshold": 14000,
      "exposeForecast": true,
      "exposeTotal": false
    }
  ]
}
```

| Option | Default | Notes |
| --- | --- | --- |
| `email` | — | Required. |
| `password` | — | Required. |
| `unit` | `liters` | `liters` or `cubic_meters`. Applies to daily/monthly/forecast. |
| `pollInterval` | `60` | Minutes. Floored at 15. |
| `dailyThreshold` | `0` | In `unit`. `0` removes the daily alert sensor. |
| `monthlyThreshold` | `0` | In `unit`. `0` removes the monthly alert sensor. |
| `exposeDaily` | `true` | Today's consumption. |
| `exposeMonthly` | `true` | This month's consumption. |
| `exposeForecast` | `true` | Month-end estimate. |
| `exposeTotal` | `false` | Cumulative reading. Always m³. |
| `nameDaily` … `nameMonthlyAlert` | — | Pin a sensor's name. See [Naming](#naming). |

### Choosing thresholds

The alerts are the part you actually get notified by, so they are worth setting.
There is no single right number — it depends on how many people live in the
house, whether you have a garden, and what the season is. Two anchors:

- **Monthly.** The subsidised household allocation in Israel is 3.5 m³ per
  person per month; past that, water costs roughly double. Setting
  `monthlyThreshold` to `3500 × people` (14000 L for a family of four) turns the
  alert into "from here on, this is expensive water".
- **Daily.** Israeli domestic use runs around 100–200 L per person per day.
  Something around double a normal day is a reasonable alarm — roughly
  `400 × people` litres, so 1600 L for a family of four — high enough that a
  long shower or a load of laundry does not trip it, low enough to catch a stuck
  irrigation valve or a running toilet within a day.

Then correct with your own data: run for a week with Homebridge debug logging on
and look at the `today=` and `month=` lines, or read the same figures in the
Read Your Meter Pro app. Set the daily threshold above your worst normal day.

Note what these alerts are and are not. They fire on *cumulative consumption in
the period*, so a daily alert stays tripped until midnight and a monthly one
until the month rolls over — they are budget alarms, not flow detectors. The
portal only publishes hourly at best, so a burst pipe is caught in hours, not
seconds.

### Naming

Every sensor name can be changed, and the change sticks:

- **Rename in the Home app** (long-press a tile → settings → name). The plugin
  records the new name in Homebridge's accessory cache, so restarts keep it.
- **Or pin it in config.json** with `nameDaily`, `nameMonthly`, `nameForecast`,
  `nameTotal`, `nameDailyAlert`, `nameMonthlyAlert`. A name set here wins over a
  rename made in the Home app, and will overwrite one on the next restart — it
  is the escape hatch, not the normal path. Leave these empty to rename in the
  Home app instead.

HomeKit only accepts names that start and end with a letter or digit (Hebrew
counts), and that otherwise contain letters, digits, spaces, apostrophes,
commas, periods or hyphens. Anything else is ignored with a warning rather than
handed to HomeKit, which would silently refuse to add the accessory at all.

### Why litres by default

HomeKit clamps light level to `0.0001 .. 100000` lux. Daily consumption in m³
lands around `0.7`, which the Home app rounds to something useless. In litres it
reads as `734`. The cumulative total is the exception — a lifetime reading in
litres blows past the 100000 ceiling, so it is always reported in m³.

### Poll politely

The meter uploads at most hourly, often daily. Polling every minute gains you
nothing and hammers someone else's infrastructure. The plugin refuses intervals
below 15 minutes.

## Behaviour worth knowing

- **Missing readings**: the portal publishes today's figure some hours into the
  day, and returns `cons: null` until it does. That is not the same as zero water
  used, so the plugin does not report it as zero — it leaves the sensor showing
  the last value it had. In practice that means `Water Usage Today` shows *yesterday's*
  total for part of the morning, then jumps to today's once the portal catches
  up. On a brand-new install there is no previous value to keep, so the sensor
  sits at `0.0001 lux` (HomeKit's floor for a light sensor, and the same value a
  genuine zero reads as) until the first real reading lands. The alerts do not
  trip or clear while a reading is missing.
- **Forecast**: `Water Monthly Forecast` is the portal's own estimate of what the
  whole current calendar month will add up to, not a rolling 30-day figure — so
  it is directly comparable to `monthlyThreshold`, and early in the month it is a
  rough number extrapolated from a few days. It is the flakiest endpoint; when it
  fails the rest of the poll still succeeds and the sensor holds its last value.
- **Names**: a rename in the Home app is stored in Homebridge's accessory cache
  and survives restarts. See [Naming](#naming) for the config.json override.
- **Auth**: the plugin logs in once, caches the bearer token, and re-authenticates
  silently on a 401. If the portal rejects your credentials outright it stops
  polling and logs an error rather than retrying on a timer and risking a lockout.
- **Credentials**: your email and password live in `config.json`, like every
  other Homebridge plugin. They are never written anywhere else and never logged.
- **State**: a generated `deviceId` and the cached session token live in
  `<homebridge storage>/.read-your-meter-pro.json` (mode 0600), following the
  same convention as `homebridge-ring`'s `.ring.json`. The `deviceId` must stay
  stable across restarts, because the portal registers a device per id. Writes
  are atomic (temp file plus rename) and serialised, so a crash mid-write cannot
  leave a truncated file that forces a new device registration on next boot.
  Deleting the file is safe: the plugin mints a new id and logs in again.
- **Failures**: a failed poll sets `StatusFault` and clears `StatusActive` on
  every service, so an outage is visible rather than silently stale. It clears on
  the next successful poll. If the *first* poll after a restart fails, cached
  accessories are still wired up so they report the fault instead of sitting at
  default values, and the plugin retries every minute until it has something to
  show before settling into the configured interval.
- **Reconfiguration**: switching a sensor off, or setting a threshold back to
  `0`, removes that service on the next restart instead of leaving a ghost.

## Development

```bash
npm install
npm run lint
npm run build
npm test        # lint + build + smoke tests against a mocked portal
```

The smoke tests need no credentials and touch no network: they stub `fetch` with
a fake portal and drive the plugin through Homebridge's real `PlatformAccessory`
and HAP-NodeJS `Service`/`Characteristic` classes. CI runs them on Node 22 and 24.

### Releasing

Releasing is a manual, deliberate act:

1. Bump the version: `npm version 1.0.0 --no-git-tag-version`.
2. Move the [`Unreleased`](CHANGELOG.md) notes into a `## [1.0.0] - YYYY-MM-DD`
   section, and add the compare link at the bottom of the file. Commit and merge
   both.
3. Actions → **release** → *Run workflow*. Give it the tag (`v1.0.0`), tick
   **prerelease** for anything like `v1.0.0-beta.2`, and run it.

The workflow re-runs the whole build on both Node versions, publishes to npm with
provenance, then creates the tag and a GitHub release whose notes are that
version's `CHANGELOG.md` section verbatim — the changelog is the source of truth,
not a generated commit list. Tick **dry run** to build and pack without
publishing anything.

It refuses to do the wrong thing rather than doing it quietly: the tag has to
match the version in `package.json` (npm publishes what `package.json` says, not
what you typed), `CHANGELOG.md` must have a non-empty section for that version,
the tag must not already exist, and a prerelease version with
the prerelease box unticked is rejected instead of being published as npm
`latest`. Prereleases publish under their own dist-tag — `1.0.0-beta.1` goes out
as `beta`, so `npm install -g` keeps giving people the stable line. Override with
the `npm_tag` input if you need something else.

There is no npm token anywhere in the workflow: publishing uses npm's trusted
publishing, which swaps the job's short-lived GitHub OIDC identity for publish
rights and produces the provenance attestation as a side effect. The only setup
required is registering this repository and workflow as a trusted publisher on
the npm package.

To preview the notes a release would get:

```bash
node scripts/changelog.mjs v1.0.0-beta.2
```

## Verifying the API against your account

If a field looks wrong, or the portal changes shape, dump the raw responses:

```bash
RYM_EMAIL=you@example.com RYM_PW='your-password' npm run probe
```

For verbose runtime logs, enable Homebridge's own debug mode (`homebridge -D`,
or the debug toggle on this plugin's child bridge in the Homebridge UI). The
plugin deliberately has no `debug` option of its own.

This prints a **redacted** summary of every endpoint the plugin uses — safe to
paste into an issue — and writes the full unredacted response to
`probe-output.json` (mode 0600, gitignored) for your own inspection. Delete that
file when you are done.

## Credits

Endpoint knowledge derived from [pyrympro](https://github.com/OnFreund/pyrympro)
(MIT, On Freund). Originally inspired by
[read_your_meter](https://github.com/eyalcha/read_your_meter) (Apache-2.0,
eyalcha). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

MIT
