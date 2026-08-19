# Architecture

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
├── test/
│   └── server.test.js # Pure-function unit tests + route integration tests
└── doc/
    └── architecture.md
```

## How it works

lanyell is a small Node.js app. Its only runtime dependency is [`qrcode`](https://www.npmjs.com/package/qrcode), used to render the terminal QR code on startup.

### HTTP routes

| Route | Purpose |
|-------|---------|
| `GET /` | Serves the page (input box + message list) |
| `POST /send` | Stores a message and broadcasts it |
| `DELETE /messages/:id` | Deletes a message and broadcasts the removal |
| `GET /events` | SSE stream that pushes add/delete events to every open tab |

### Live updates (SSE)

Every open tab keeps an `EventSource` connection to `/events`. The store broadcasts typed events — `{type: "add", message}` and `{type: "delete", id}` — and the client dispatches on `type`. New tabs receive the full history on connect. Messages are kept in memory only (cleared on restart).

### Design decisions

- **Single CLI entry, modular internals**: `server.js` is a thin entry that wires `lib/` modules together; `require.main === module` guards so tests can `require()` the exports without starting a listener.
- **Dependency injection**: `routes.js` exposes `createHandler(store, html)` so the routing logic is unit-testable without a real socket.
- **Server-side color map**: the device→color mapping lives on the server so every client renders the same device in the same color (a client-side map would race across tabs).
- **Device id ceiling**: browsers expose no MAC/hardware identifier. The id is an OS prefix (parsed from User-Agent) plus a localStorage-persisted random segment — stable per browser instance, reset by clearing site data. This is the environment ceiling; real identity would require accounts.
- **Clipboard asymmetry**: copy works over plain http via an `execCommand` fallback, but paste (reading the clipboard) is unavailable on non-secure contexts and `execCommand('paste')` is blocked in modern browsers — hence no paste button.
- **Fold keeps formatting**: folded content is clipped with `max-height + overflow:hidden` on pre-wrap text. `-webkit-line-clamp` was rejected because it merges newlines and breaks the original formatting.
