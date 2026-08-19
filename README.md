# lanyell

A LAN message board. Run one command and anyone on your WiFi can post messages that show up live on every screen.

## Quick start

```bash
npx lanyell
```

On startup, lanyell prints the local URL **plus a terminal QR code** — others on your LAN just scan it with their phone to open, no typing required.

- **You:** http://localhost:3000
- **Others on your LAN:** http://&lt;your-LAN-IP&gt;:3000 (or scan the QR code)

> If others can't reach it, your OS firewall is likely blocking port 3000 — allow Node through it.

### Custom port

```bash
npx lanyell --port 8080
# or: npx lanyell -p 8080
```

If the port is already in use or requires root, lanyell prints a clear error instead of crashing silently.

## How it works

lanyell is a small Node.js app. Its only runtime dependency is [`qrcode`](https://www.npmjs.com/package/qrcode), used to render the terminal QR code on startup. It serves these routes:

| Route | Purpose |
|-------|---------|
| `GET /` | Serves the page (input box + message list) |
| `POST /send` | Stores a message and broadcasts it |
| `DELETE /messages/:id` | Deletes a message and broadcasts the removal |
| `GET /events` | SSE stream that pushes add/delete events to every open tab |

Messages are kept in memory (cleared on restart). New tabs receive the full history on connect.

## Project structure

```
lanyell/
├── server.js          # CLI entry: wires modules together, starts the server, prints the QR code
├── lib/
│   ├── colors.js      # Per-device color palette + stable assignment
│   ├── device.js      # OS detection from User-Agent + LAN IP discovery
│   ├── sse.js         # SSE frame encoding + broadcast helper
│   ├── store.js       # In-memory message store (immutable updates)
│   ├── routes.js      # Dependency-injected HTTP request handler (unit-testable)
│   └── args.js        # Minimal CLI arg parsing (--port / -p)
├── public/
│   └── index.html     # The served page (input box, message list, client JS)
└── test/
    └── server.test.js # Pure-function unit tests + route integration tests
```

## Features

- **Live updates** via Server-Sent Events — no refresh needed
- **Terminal QR code** — scan to open on mobile, no typing required
- **Auto-growing input** — single line by default, expands up to 4 lines (Enter to send, Shift+Enter for newline)
- **Paste button** — one tap to fill the input from the clipboard (over HTTPS/localhost); falls back to focusing the input with a manual-paste hint over plain http, where browsers block programmatic clipboard reads
- **Per-device colors** — each device gets a stable light tint so you can tell senders apart
- **Delete messages** — anyone can remove a message; the change syncs to every screen instantly
- **Responsive** — on phone-width screens the input and its buttons stack vertically so nothing is cramped
- **Custom port** — `--port` / `-p` to pick a port; clear errors on conflict or permission
- **Device id** — OS prefix (`iOS` / `macOS` / `Windows` / ...) + a persisted random segment
- **Copy button** on every message (works over plain HTTP via `execCommand` fallback)

## Develop

```bash
git clone https://github.com/boomsi/lanyell.git
cd lanyell
npm install
node server.js
```

### Test

```bash
npm test
```

Tests use Node's built-in `node:test`.

## Requirements

Node.js >= 18

## License

[MIT](./LICENSE)
