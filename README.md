# homebridge-read-your-meter-pro

Exposes water consumption from the Israeli [Read Your Meter Pro](https://rym-pro.com)
portal (ARAD meters) in HomeKit.

Unofficial, and not affiliated with Arad Group or any water corporation.

## Read this before installing

**HomeKit has no water-consumption service.** There is no accessory type in the
HomeKit Accessory Protocol for volume or metering, so there is no honest way to
show "0.734 m³" in the Home app. This plugin works around that:

| What you get | How | Where it shows |
| --- | --- | --- |
| Today's consumption | Light sensor `Water Today` | Home app, as `734 lux` |
| This month's consumption | Light sensor `Water This Month` | Home app, as `14200 lux` |
| Month-end forecast | Light sensor `Water Forecast` | Home app |
| Cumulative meter reading | Light sensor `Water Meter Total` | Home app, optional, always m³ |
| Daily threshold exceeded | Leak sensor `Water Daily Alert` | Home app, notifications, automations |
| Monthly threshold exceeded | Leak sensor `Water Monthly Alert` | Home app, notifications, automations |

The word "lux" is wrong and there is nothing to be done about it. The number is
correct. Service names carry no unit, because HomeKit rejects names that end in
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
      "dailyThreshold": 500,
      "monthlyThreshold": 20000,
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
| `dailyThreshold` | `0` | In `unit`. `0` removes the sensor. |
| `monthlyThreshold` | `0` | In `unit`. `0` removes the sensor. |
| `exposeForecast` | `true` | Month-end estimate. |
| `exposeTotal` | `false` | Cumulative reading. Always m³. |

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
  the next successful poll.
- **Reconfiguration**: setting a threshold to `0`, or turning off the forecast or
  total, removes those services on the next restart instead of leaving ghosts.

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
