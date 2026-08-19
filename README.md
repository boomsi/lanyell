# lanyell

A zero-dependency, single-file LAN message board. Run one command and anyone on your WiFi can post messages that show up live on every screen.

## Quick start

```bash
npx lanyell
```

Then open:

- **You:** http://localhost:3000
- **Others on your LAN:** http://&lt;your-LAN-IP&gt;:3000

> If others can't reach it, your OS firewall is likely blocking port 3000 — allow Node through it.

## How it works

lanyell is a single Node.js file with no dependencies. It serves three routes:

| Route | Purpose |
|-------|---------|
| `GET /` | Serves the page (input box + message list) |
| `POST /send` | Stores a message and broadcasts it |
| `GET /events` | SSE stream that pushes new messages to every open tab |

Messages are kept in memory (cleared on restart). New tabs receive the full history on connect.

## Features

- **Live updates** via Server-Sent Events — no refresh needed
- **Auto-growing input** — single line by default, expands up to 4 lines (Enter to send, Shift+Enter for newline)
- **Per-device colors** — each device gets a stable light tint so you can tell senders apart
- **Device id** — OS prefix (`iOS` / `macOS` / `Windows` / ...) + a persisted random segment
- **Copy button** on every message (works over plain HTTP via `execCommand` fallback)
- **Zero dependencies** — only Node.js built-ins

## Develop

```bash
git clone https://github.com/boomsi/lanyell.git
cd lanyell
node server.js
```

### Test

```bash
npm test
```

Tests use Node's built-in `node:test` — no dependencies required.

## Requirements

Node.js >= 18

## License

[MIT](./LICENSE)
