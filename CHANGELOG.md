# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a matching `vX.Y.Z` git tag; the release workflow uses
the section below the matching heading as the GitHub release notes, so keep the
headings in the `## [x.y.z] - YYYY-MM-DD` form.

## [Unreleased]

## [1.0.0-beta.5] - 2026-08-20

### Added

- `weeklyWindow: rolling` makes the weekly sensor and its alert cover the **last
  7 days** — always the seven days ending today — instead of the calendar week.
  It never resets, so it reads roughly steady from day to day and a threshold on
  it means the same thing whenever it trips, where a calendar-week threshold can
  only trip late in the week. It is correspondingly not "this week": a heavy day
  keeps counting until it ages out a week later. Still summed from the daily
  window already fetched, so it adds no requests.

### Changed

- **`weekStart` is now `weeklyWindow`.** The setting took `sunday` or `monday`,
  and `rolling` is not a day, so "week starts on" no longer described it. A
  `weekStart` left in `config.json` is ignored and the weekly figure falls back
  to the Sunday calendar week — rename the key to keep a `monday` week.
- The setting is required in the settings form, so the dropdown no longer offers
  the Homebridge UI's blank "None" entry. It never meant anything: leaving it
  selected wrote no value and the weekly figure fell back to the Sunday week.
  Anything unrecognised in `config.json` still falls back the same way.
- The weekly documentation now covers both windows and when to prefer each,
  rather than only the calendar week.

## [1.0.0-beta.4] - 2026-08-20

### Added

- Weekly sensors, both off by default: `Water Usage This Week` (a light sensor,
  `exposeWeekly`) and `Water Weekly Alert` (a leak sensor, `weeklyThreshold`).
  The figure is the **current calendar week to date**, not a rolling seven days,
  and it resets on the `weekStart` day — `sunday` by default, `monday` optional.
  It is summed from the daily window the plugin already fetches, so it adds no
  requests. The publication lag applies: the total covers only the days the
  portal has published, and the debug log reports how many that is
  (`week=911L (3 of 5 days from 2026-08-16)`). A week with nothing published yet
  holds the previous week's total rather than showing zero, so at a week boundary
  both the sensor and its alert can lag by a day or two.
- `nameWeekly` and `nameWeeklyAlert` join the other name overrides.

### Fixed

- `Water Usage Daily` could sit at `0.0001 lux` indefinitely. The daily lookup
  only ever asked the portal about today, but the portal publishes a day's figure
  a day or more after that day starts — measured on a real account, both today
  and yesterday came back `cons: null` and the newest published figure was two
  days old — so no value was ever reported and the sensor never left HomeKit's
  floor. The lookup now asks for a seven-day window and uses the most recent
  published day, preferring today's figure when it exists. The day a figure
  belongs to is logged at debug level (`daily=140L (for 2026-08-18)`) so a
  lagging portal is distinguishable from a stuck reading.
- A `null` consumption figure reaching the numeric conversion would have become
  `0` rather than "no reading", because `Number(null)` is `0`. The daily path
  guarded against this before converting; the monthly and forecast paths did not,
  so a null there was reported as zero consumption — and would have cleared a
  tripped monthly alert.
- The daily lookup no longer picks a row by position. It selects by `consDate`,
  which the range query makes load-bearing: the portal happens to return days in
  ascending order, but nothing documents that.

- A rate-limited cold start no longer retries every minute. Before the first
  successful poll the retry delay was a flat 60 seconds, including when the
  failure was `HTTP 429` — and since the portal limits logins per account, each
  of those retries re-attempted a login and held open the limit it was waiting
  on. A poll throttled past its retry budget now backs off 15 minutes, and says
  so in the log.
- `npm run probe` no longer registers a new device on every run. It generated a
  fresh `deviceId` per invocation, so each run was a new device registration plus
  a new login; a handful of runs could exhaust the account's login limit and lock
  out the plugin as well. It now caches a device id and session token in
  `.probe-state.json` (mode 0600, gitignored), reuses the token until it expires,
  and can borrow the running plugin's session instead via `RYM_STATE_FILE`.
- The probe reports an `HTTP 429` as a rate limit, with the `Retry-After` the
  portal sent and what to do about it, instead of `code=429` and an opaque
  message. It also spaces its requests like the plugin does.

### Changed

- `npm run probe` also dumps the daily endpoint over a seven-day window and
  prints which days came back published, which is what identifies a publication
  lag on a given account.
- Docs and the settings form no longer describe the daily sensor as today's
  consumption. It is the latest day the portal has published, which is not always
  today, and the daily alert is correspondingly a verdict on a completed day
  rather than a live figure.
- The daily sensor's default name is `Water Usage Daily`, since `Water Usage
  Today` promised something the portal does not reliably deliver. A sensor that
  already exists keeps whatever name it is currently showing; rename it in the
  Home app if you want the new one.

## [1.0.0-beta.3] - 2026-08-20

### Added

- Rate-limit handling. An `HTTP 429` from the portal is now retried inside the
  same poll — three retries backing off roughly 2s, 8s and 30s with jitter,
  honouring a `Retry-After` header when the portal sends one (and giving up
  rather than stalling when it asks for more than a minute). Previously a single
  429 cost a whole poll interval of stale readings. Retries are logged at debug
  level.

### Changed

- A poll now issues its requests one at a time, spaced apart, instead of firing
  the daily, monthly and forecast requests in parallel. The burst was the likely
  trigger for the 429s in the first place, and a poll has an hour to finish.
- A single failed poll no longer faults the sensors. The last known readings are
  held and the failure is logged with a count; `StatusFault` is raised once three
  consecutive polls have failed. A failed *first* poll after a restart still
  faults immediately, since there is nothing to hold.
- Shutdown now cancels an in-flight request or a pending retry backoff instead of
  letting it run to completion.

## [1.0.0-beta.2] - 2026-08-19

### Added

- Every sensor can now be switched off individually. `Today's consumption` and
  `This month's consumption` join the forecast and total sensors as toggles
  (`exposeDaily`, `exposeMonthly`), and a sensor switched off is removed from
  HomeKit on the next restart.
- Sensor names can be changed. A rename in the Home app is remembered across
  restarts, and the six `name*` settings (`nameDaily`, `nameMonthly`,
  `nameForecast`, `nameTotal`, `nameDailyAlert`, `nameMonthlyAlert`) pin a name
  from config.json, overriding both the default and a Home app rename. Names
  that HomeKit would reject are ignored with a warning.
- A warning at startup when every sensor is switched off, since the accessory
  would otherwise appear in HomeKit with nothing on it.
- Manual `release` workflow: validates the requested tag against
  `package.json`, re-runs the full build matrix, publishes to npm with
  provenance via trusted publishing (no npm token), and creates the tag and
  GitHub release. Supports prereleases, npm dist-tag overrides and dry runs.

### Changed

- Default sensor names are clearer and consistent: `Water Usage Today`,
  `Water Usage This Month`, `Water Monthly Forecast`, `Water Meter Total`,
  `Water Daily Alert`, `Water Monthly Alert`. Existing installs keep the name
  currently shown in the Home app rather than being reset.
- The settings form groups sensors and names into their own sections, and the
  threshold descriptions now suggest concrete starting values (roughly 400 L per
  person per day; 3500 L per person per month, the subsidised Israeli household
  allocation).
- `build` runs on `develop` as well as `main`, and is callable from other
  workflows so a release can be gated on exactly those checks.
- Non-ASCII characters (`m³`, em dashes) in the settings form are written
  literally instead of escaped.
- README documents the sensor table, the per-sensor toggles and the naming
  rules.

### Fixed

- The physical meter serial number is reported again. It was only applied when
  the daily reading was present, because the update was nested inside the
  daily-reading branch.

## [1.0.0-beta.1] - 2026-08-19

First public prerelease.

### Added

- Homebridge dynamic platform plugin exposing water consumption from the
  Israeli Read Your Meter Pro portal (ARAD meters) in HomeKit.
- Consumption as light sensors — today, this month, the portal's month-end
  forecast, and the cumulative meter reading (opt-in, always m³) — because HAP
  has no volume or metering service. Values can be reported in litres or m³.
- Daily and monthly threshold alerts as leak sensors, so HomeKit notifications
  and automations work; a threshold of `0` removes the sensor.
- Polling with a configurable interval, floored at 15 minutes, and a
  `StatusFault` / `StatusActive` signal when the portal cannot be reached.
- Login and reading state persisted in a single dot-prefixed file at the
  Homebridge storage root, so a restart does not force a fresh login.
- A cold-start failure is logged and retried rather than leaving the platform
  silently dead.
- Homebridge UI settings form (`config.schema.json`) covering credentials,
  unit, poll interval, thresholds and the optional sensors.
- `npm run probe`: a standalone, dependency-free script that dumps the raw shape
  of every API endpoint the plugin uses, with sensitive fields redacted on
  stdout, for verifying field names against a real account.
- No runtime dependencies, which keeps installation on a Raspberry Pi to a
  single request.
- CI on Node.js 22 and 24 running lint, build and smoke tests, plus a packing
  check that fails if the published tarball loses `dist/` or
  `config.schema.json`.

[Unreleased]: https://github.com/Aransh/homebridge-read-your-meter-pro/compare/v1.0.0-beta.5...HEAD
[1.0.0-beta.5]: https://github.com/Aransh/homebridge-read-your-meter-pro/compare/v1.0.0-beta.4...v1.0.0-beta.5
[1.0.0-beta.4]: https://github.com/Aransh/homebridge-read-your-meter-pro/compare/v1.0.0-beta.3...v1.0.0-beta.4
[1.0.0-beta.3]: https://github.com/Aransh/homebridge-read-your-meter-pro/compare/v1.0.0-beta.2...v1.0.0-beta.3
[1.0.0-beta.2]: https://github.com/Aransh/homebridge-read-your-meter-pro/compare/v1.0.0-beta.1...v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/Aransh/homebridge-read-your-meter-pro/releases/tag/v1.0.0-beta.1
