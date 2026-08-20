# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a matching `vX.Y.Z` git tag; the release workflow uses
the section below the matching heading as the GitHub release notes, so keep the
headings in the `## [x.y.z] - YYYY-MM-DD` form.

## [Unreleased]

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

[Unreleased]: https://github.com/Aransh/homebridge-read-your-meter-pro/compare/v1.0.0-beta.2...HEAD
[1.0.0-beta.2]: https://github.com/Aransh/homebridge-read-your-meter-pro/compare/v1.0.0-beta.1...v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/Aransh/homebridge-read-your-meter-pro/releases/tag/v1.0.0-beta.1
