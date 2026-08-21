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
| Latest daily consumption[^lag] | Light sensor | `Water Usage Daily` | yes |
| This week's consumption[^week] | Light sensor | `Water Usage This Week` | no |
| This month's consumption | Light sensor | `Water Usage This Month` | yes |
| Month-end forecast | Light sensor | `Water Monthly Forecast` | yes |
| Cumulative meter reading | Light sensor, always m³ | `Water Meter Total` | no |
| Daily threshold exceeded | Leak sensor | `Water Daily Alert` | when a threshold is set |
| Weekly threshold exceeded | Leak sensor | `Water Weekly Alert` | when a threshold is set |
| Monthly threshold exceeded | Leak sensor | `Water Monthly Alert` | when a threshold is set |

[^lag]: **Not always today's.** The portal publishes a day's consumption some
    time after that day starts, and how long varies by account — on the one this
    was tested against, today and yesterday were both still unpublished and the
    newest figure was two days old. The sensor shows the most recent day the
    portal has actually published. See
    [Missing readings](#behaviour-worth-knowing).

[^week]: Either the current calendar week to date — resetting on the day set by
    `weeklyWindow`, Sunday by default — or the last 7 days rolling, if you set
    `weeklyWindow` to `rolling`. Summed from the daily figures the plugin already
    fetches, so it costs no extra requests, and missing whichever recent days the
    portal has not published yet. See [This week](#behaviour-worth-knowing).

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
      "pollInterval": 90,
      "dailyThreshold": 800,
      "weeklyThreshold": 3500,
      "monthlyThreshold": 14000,
      "weeklyWindow": "sunday",
      "exposeWeekly": true,
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
| `unit` | `liters` | `liters` or `cubic_meters`. Applies to daily/weekly/monthly/forecast. |
| `pollInterval` | `90` | Minutes. Floored at 15. Shorter intervals risk the portal's rate limit. |
| `dailyThreshold` | `0` | In `unit`. `0` removes the daily alert sensor. |
| `weeklyThreshold` | `0` | In `unit`. `0` removes the weekly alert sensor. |
| `monthlyThreshold` | `0` | In `unit`. `0` removes the monthly alert sensor. |
| `weeklyWindow` | `sunday` | `sunday`, `monday` or `rolling`. Calendar week from that day, or the last 7 days. |
| `exposeDaily` | `true` | Latest published day's consumption. |
| `exposeWeekly` | `false` | This week's consumption so far. |
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
- **Weekly.** Between the two, and less jumpy than the daily one: a single heavy
  day does not trip it, a week of them does. Roughly a quarter of the monthly
  allocation is a sensible start — `875 × people` litres, so 3500 L for a family
  of four — which lands the alert late in a week that is heading over budget.
  Remember it only counts the days the portal has published, so a week that is
  genuinely over may not show it until a day or two later. If you want the alert
  to mean the same thing every day of the week, set `weeklyWindow` to `rolling`
  first: a calendar-week threshold can only trip late in the week, while a rolling
  one is a steady "seven days' worth" line.

Then correct with your own data: run for a week with Homebridge debug logging on
and look at the `daily=` and `month=` lines, or read the same figures in the
Read Your Meter Pro app. Set the daily threshold above your worst normal day.

Note what these alerts are and are not. They fire on *cumulative consumption in
the period*, so a daily alert stays tripped until the next published day and a
monthly one until the month rolls over — they are budget alarms, not flow
detectors. And the daily one judges whichever day the portal has published most
recently, which on some accounts is two days back, so it reports a day you have
already finished living. Check your own lag with `npm run probe` before relying
on the timing of it.

### Naming

Every sensor name can be changed, and the change sticks:

- **Rename in the Home app** (long-press a tile → settings → name). The plugin
  records the new name in Homebridge's accessory cache, so restarts keep it.
- **Or pin it in config.json** with `nameDaily`, `nameWeekly`, `nameMonthly`,
  `nameForecast`, `nameTotal`, `nameDailyAlert`, `nameWeeklyAlert`,
  `nameMonthlyAlert`. A name set here wins over a
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
nothing and hammers someone else's infrastructure. The default is 90 minutes,
which stays clear of the portal's rate limit, and the plugin refuses intervals
below 15 minutes.

## Behaviour worth knowing

- **Missing readings, and why the daily sensor can be a day or two behind**:
  the portal returns a row for every day from midnight onwards, but leaves its
  `cons` null until your meter's reading for that day has been processed. That is
  not a matter of hours. Measured on a real account at 17:15, both today and
  yesterday were `cons: null` and the newest published figure was from two days
  earlier; the six days before that were all populated. How far behind your
  account runs is worth checking with `npm run probe`, which prints exactly this.

  So `Water Usage Daily` shows **the most recent day the portal has published** —
  today's figure when there is one, otherwise the newest completed day, looking
  back up to a week. Which day that is appears in the debug log:

  ```
  Meter 61007: daily=140L (for 2026-08-18) week=911L (3 of 5 days from 2026-08-16) month=3477L forecast=5818L total=254.7m³
  ```

  That date is the thing to look at: it distinguishes a portal that is behind from
  a sensor that is stuck. Nothing published within the last week is treated as no
  data rather than passed off as current — the sensor holds its last value, since
  a null is not the same as zero water used. On a brand-new install there is no
  last value to hold, so the sensor reads `0.0001 lux` until the first figure
  lands: HomeKit's floor for a light sensor, and the same value a genuine zero
  reads as. If it is still sitting there after a poll or two, the debug log will
  say whether the portal is returning nulls or the requests are failing.

  Two consequences worth being clear about. The sensor's name is aspirational on
  a lagging account — it is the latest daily total, not today's. And the daily
  alert is a verdict on that day, so on a two-day lag it fires about a completed
  day two days ago: a budget alarm, useless for catching a burst pipe now. The
  alerts do not trip or clear at all while a figure is missing.
- **This week**: `Water Usage This Week` sums whichever days of the week the
  portal has published, out of the same window the daily figure comes from — so
  switching it on costs no extra requests. `weeklyWindow` decides what "the week"
  means, and the two options behave quite differently:

  - `sunday` (default) or `monday` — the **current calendar week to date**. It
    resets on that day the way the monthly figure resets on the first, so it
    answers "how much this week", and a threshold on it is a weekly budget.
  - `rolling` — the **last 7 days**, always ending today. It never resets, so it
    is roughly steady from day to day and a threshold on it means the same thing
    whenever it trips. It is not "this week": a heavy Sunday keeps counting until
    it ages out the following Sunday, and there is no point at which the figure
    starts from nothing.

  Whichever you pick, the publication lag applies. The total is normally short
  whichever recent days the portal has not published — the debug line above says
  `3 of 5 days`, which is what separates a genuinely light week from an incomplete
  one — so treat it as a floor, not a total, and read the start date in that line
  to confirm which window is in force.

  The lag bites hardest on a calendar week: in the first day or two of a new week
  the portal may have published nothing from it yet. Rather than show a zero week,
  the sensor and its alert hold last week's final state until the first day of the
  new week lands — so around the reset the tile is briefly last week's number,
  which is the same reason the daily sensor is not always today's. `rolling` avoids
  that: a seven-day window almost always contains a published day.
- **Forecast**: `Water Monthly Forecast` is the portal's own estimate of what the
  whole current calendar month will add up to, not a rolling 30-day figure — so
  it is directly comparable to `monthlyThreshold`, and early in the month it is a
  rough number extrapolated from a few days. It is the flakiest endpoint; when it
  fails the rest of the poll still succeeds and the sensor holds its last value.
- **Names**: a rename in the Home app is stored in Homebridge's accessory cache
  and survives restarts. See [Naming](#naming) for the config.json override.
- **Auth**: the plugin logs in once, caches the bearer token, and re-authenticates
  silently on a 401. If the portal rejects your email and password outright it
  stops polling and logs an error rather than retrying on a timer and risking a
  lockout. A 401 that a fresh login does not clear is treated as an ordinary
  endpoint failure instead — it faults the sensors but keeps polling, because
  that is a portal problem and not something you can fix in the config.
- **Credentials**: your email and password live in `config.json`, like every
  other Homebridge plugin. They are never written anywhere else and never logged.
- **State**: a generated `deviceId` and the cached session token live in
  `<homebridge storage>/.read-your-meter-pro.json` (mode 0600), following the
  same convention as `homebridge-ring`'s `.ring.json`. The `deviceId` must stay
  stable across restarts, because the portal registers a device per id. Writes
  are atomic (temp file plus rename) and serialised, so a crash mid-write cannot
  leave a truncated file that forces a new device registration on next boot.
  Deleting the file is safe: the plugin mints a new id and logs in again.
- **Rate limiting**: the portal answers bursts with `HTTP 429`. A poll therefore
  issues its requests one at a time, spaced a little apart, rather than firing
  them in parallel, and a request that is throttled anyway is retried within the
  same poll — three retries, backing off roughly 2s, 8s then 30s with jitter. A
  `Retry-After` header wins over that ladder when the portal sends one, unless it
  asks for longer than a minute, in which case the poll gives up and the next one
  tries again. Retries are logged at debug level; you only see a warning if every
  retry was throttled too. A poll that is throttled even after its retries backs
  off for 15 minutes before the next attempt, overriding the one-minute cold-start
  retry: the portal limits logins per account, so a restart during a rate limit
  would otherwise re-attempt a login every minute and hold open the very limit it
  is waiting on. Nothing needs fixing when this happens — it clears on its own.
- **Failures**: three consecutive failed polls set `StatusFault` and clear
  `StatusActive` on every service, so a real outage is visible rather than
  silently stale. A single failure is logged but leaves the readings alone: the
  data is hourly at best, so replacing an hour-old reading with a fault badge
  over one bad request is a worse trade than showing it for another interval.
  Faults clear on the next successful poll. If the *first* poll after a restart
  fails there is nothing worth holding, so cached accessories are wired up and
  faulted immediately instead of sitting at default values, and the plugin
  retries every minute until it has something to show before settling into the
  configured interval.
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
and HAP-NodeJS `Service`/`Characteristic` classes. CI runs them on Node 22 and
24, and once more against `homebridge@1` — the suite picks up whichever
HAP-NodeJS the installed Homebridge brings, so the `^1.8.0` half of
`engines.homebridge` is checked rather than assumed.

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

The portal registers a device per `deviceId` and rate-limits logins per account,
so the probe reuses one: it caches its own device id and session token in
`.probe-state.json` (mode 0600, gitignored) and logs in only when that token has
expired. If you are already rate-limited, or would rather not add a second
session, point it at the running plugin's state file and it will borrow that
session and not log in at all:

```bash
RYM_STATE_FILE=/var/lib/homebridge/.read-your-meter-pro.json npm run probe
```

That file is only ever read, never written. In Docker it is at the container's
storage path — `/homebridge/.read-your-meter-pro.json` by default, reachable
through the mounted volume.

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
