<p align="center">
  <img src="https://raw.githubusercontent.com/boomsi/lanyell/main/app/src-tauri/icons/lanyell-logo.svg" width="128" height="128" alt="lanyell logo" />
</p>

<h1 align="center">lanyell</h1>

A LAN message board. Run one command and anyone on your WiFi can post messages that show up live on every screen.

**Website: https://boomsi.github.io/lanyell/**

## Usage

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

## Features

- **Live updates** via Server-Sent Events — no refresh needed
- **Terminal QR code** — scan to open on mobile, no typing required
- **Auto-growing input** — single line by default, expands up to 8 rows; two rows by default on phones
- **Fold long messages** — long messages clip at 222px with a per-item expand/collapse toggle
- **Per-device colors** — each device gets a stable light tint so you can tell senders apart
- **Delete messages** — anyone can remove a message; the change syncs to every screen instantly
- **Responsive** — on phone-width screens the input and buttons stack vertically so nothing is cramped
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

Tests: `npm test` (Node's built-in `node:test`).

## Requirements

Node.js >= 18

## License

[MIT](./LICENSE)
