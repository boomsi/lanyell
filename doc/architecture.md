# Architecture

## Project structure

```
lanyell/
├── server.js          # CLI entry: wires modules together, starts the server, prints the QR code
├── lib/
│   ├── colors.js      # Per-device color palette + stable assignment
│   ├── device.js      # OS detection from User-Agent + LAN IP discovery
│   ├── files.js       # Attachment storage: streamed to disk, sanitized metadata
│   ├── listen.js      # Port binding with next-free-port fallback
│   ├── sse.js         # SSE frame encoding + broadcast helper
│   ├── store.js       # In-memory message store (immutable updates) + TTL eviction
│   ├── routes.js      # Dependency-injected HTTP request handler (unit-testable)
│   └── args.js        # Minimal CLI arg parsing (--port / -p)
├── public/
│   └── index.html     # The served page (input box, message list, client JS)
├── test/
│   └── *.test.js      # Pure-function unit tests + route integration tests
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
| `POST /files` | Streams an attachment to disk, returns its id + metadata |
| `GET /files/:id` | Streams an attachment back as a download |
| `GET /files/:id/preview` | Serves a bitmap inline so the UI can show a thumbnail |
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
- **Attachments live on disk, messages live in memory**: SSE carries a message's full text, but it can never carry a file's bytes, so an attachment message broadcasts only its metadata and the bytes are fetched on demand from `GET /files/:id`. The upload streams straight to disk (`req.pipe(stream)`), so the file never sits in memory and size is bounded by disk, not RAM.
- **The client's filename is never a path**: files are stored under a server-generated UUID and the original name is metadata only — path traversal has no surface to attack. Downloads always send `Content-Disposition: attachment`, `application/octet-stream` and `X-Content-Type-Options: nosniff`; rendering uploaded content inline on the board's own origin would turn a shared `.html` file into stored XSS that could read the SSE stream.
- **Attachments expire with their message**: messages are in memory and vanish on restart, so the attachment directory is wiped at startup and each file is unlinked when its message is deleted or swept. A file outliving its message would just be an orphan nothing points at. Uploads that never become a message are reclaimed by the same sweep, after a grace period that stops it from deleting an attachment still in flight.
- **Top-level error boundary**: the request handler wraps its routing body in a guard that turns an unexpected throw into a 500 plus a stack on stderr, instead of letting it become an unhandled rejection that terminates the process. This is not error-swallowing — a data bug still needs fixing — but the alternative is worse than it looks here: messages live in memory, so one crashing request takes the whole board's contents with it. Two real bugs (a malformed URL escape, a filename truncated mid-surrogate-pair) were amplified from "one bad request" into "the entire board is gone" by exactly this missing layer. Use `res.destroy()` when headers are already sent (an SSE stream or a download mid-flight).
- **Two-step send**: files go to `POST /files` first and `/send` then references them by id, so the request body stays small and large attachments are not bounded by the `/send` body cap. The server treats its own record of each name and size as authoritative, so the second request cannot misreport either.
- **Thumbnails need one deliberate exception**: `GET /files/:id` always sends `attachment`, which is exactly what stops an uploaded file from rendering on the board's origin — and also what would stop an `<img>` from showing it. So `GET /files/:id/preview` exists as the single route that serves uploads inline, fenced three ways: the type is sniffed from the file's **magic bytes** (never the client's declared MIME, which is the MIME-confusion entry point), only a whitelist of raster formats passes (SVG is excluded on purpose — it is XML that can carry script, and an `<img>` thumbnail has no use for it), and the response still carries `nosniff`. Anything that does not sniff as an allowed bitmap 404s, and the UI falls back to a type icon.
- **The declared MIME is fine for cosmetics, never for security**: the icon next to a filename comes from the client-declared type, because picking a wrong icon is harmless. Everything that could execute or be trusted — the preview's `Content-Type`, the download's `Content-Type`, a message's name and size — comes from the server's own record.
