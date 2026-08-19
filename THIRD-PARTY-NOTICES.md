# Third-party notices

This plugin contains no third-party code. It does, however, owe its
understanding of the Read Your Meter Pro API to prior work, acknowledged here.

## pyrympro

The endpoint layout used in `src/rympro.ts` — the base URL, the
`/consumer/login`, `/consumer/me`, `/consumption/last-read`,
`/consumption/forecast/{meter}`, `/consumption/{daily,monthly}/{meter}/{from}/{to}`
paths, the `x-access-token` header, and the meaning of login error code 5060 —
was derived from **pyrympro** by On Freund, used by the Home Assistant
`rympro` integration.

- Source: https://github.com/OnFreund/pyrympro
- License: MIT

```
MIT License

Copyright (c) 2022 On Freund

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## read_your_meter

The original inspiration for this plugin was **read_your_meter** by eyalcha
(Apache-2.0), a Home Assistant custom component that scraped the older
Selenium-driven portal. No code from that project is used here — it targets a
different portal by a different mechanism — but credit is due for showing the
problem was worth solving.

- Source: https://github.com/eyalcha/read_your_meter
- License: Apache-2.0
