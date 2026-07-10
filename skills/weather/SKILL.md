---
name: weather
description: Get the current weather or a short forecast for a place. Use when the user asks about weather, temperature, or whether to bring an umbrella.
metadata:
  crablite:
    requires:
      bins: ["curl"]
---

# weather

Fetch a quick weather report from wttr.in using the `exec` tool. No API key needed.

- Current + 3-day, compact: `curl -s 'wttr.in/<place>?format=3'`
- One-line current: `curl -s 'wttr.in/Barcelona?format=%l:+%c+%t+(feels+%f),+wind+%w'`
- Full forecast (narrow): `curl -s 'wttr.in/Barcelona?0nqT'`

Replace `<place>` with a city, airport code, or `~Landmark`. URL-encode spaces as `+` or `%20`.
Summarize the result in one or two friendly sentences; don't paste the raw ASCII art.
