#!/usr/bin/env node
// lanyell — a zero-dependency, single-file LAN message board.
// Run: npx lanyell   (or: node server.js)
// Open: http://<your-LAN-IP>:3000
// How it works: GET / serves the page; POST /send stores a message;
// GET /events streams new messages to every open tab via SSE.

const http = require('http');

const PORT = 3000;
const HOST = '0.0.0.0'; // listen on all interfaces so LAN peers can reach it

// In-memory message list (immutable updates: always build a new array)
let messages = [];
// Active SSE long-poll response objects
const clients = new Set();

// Simple unique id generator
let counter = 0;
const nextId = () => Date.now() + '-' + (counter++);

// Wrap one message into an SSE data frame (string concat avoids nested template literals)
function sseFrame(msg) {
  return 'data: ' + JSON.stringify(msg) + '\n\n';
}

// Parse OS from User-Agent (server-side fallback, never returns "unknown")
function parseOsFromUa(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Web';
}

// Device color palette: 8 distinct light tints. New devices cycle through in
// arrival order so peers are easy to tell apart visually. The mapping lives on
// the server so every client renders the same device in the same color (a
// client-side map would race across tabs and split colors for one device).
const DEVICE_COLORS = [
  '#e3f2fd', // blue
  '#e8f5e9', // green
  '#fff3e0', // orange
  '#fce4ec', // pink
  '#f3e5f5', // purple
  '#e0f7fa', // cyan
  '#fffde7', // yellow
  '#efebe9'  // brown-grey
];
const deviceColorMap = new Map();
let colorIndex = 0;

// Stable color for a device: reuse if already assigned, otherwise take the next slot
function colorForDevice(device) {
  if (deviceColorMap.has(device)) return deviceColorMap.get(device);
  const color = DEVICE_COLORS[colorIndex % DEVICE_COLORS.length];
  deviceColorMap.set(device, color);
  colorIndex++;
  return color;
}

// Embedded HTML page: input box + message list
const HTML = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  <title>lanyell</title>',
  '  <style>',
  '    * { box-sizing: border-box; }',
  '    body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #f5f5f7; color: #222; }',
  '    .wrap { width: 100%; max-width: 800px; margin: 0 auto; padding: 24px 16px 48px; }',
  '    h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }',
  '    .status { font-size: 12px; color: #999; }',
  '    form { display: flex; gap: 8px; margin: 16px 0; align-items: flex-end; }',
  // textarea auto-grow: single line by default, expands with content.
  // JS only sets height = scrollHeight; the CSS max-height caps it at ~4 lines,
  // so the box-sizing border-box padding is preserved at every row count.
  '    textarea { flex: 1; padding: 11px 14px; font-size: 16px; line-height: 1.5; border: 1px solid #ddd; border-radius: 10px; outline: none; background: #fff; resize: none; overflow: hidden; height: 44px; max-height: 110px; }',
  '    textarea:focus { border-color: #4a90d9; }',
  '    button { padding: 11px 18px; font-size: 16px; border: none; border-radius: 10px; background: #4a90d9; color: #fff; cursor: pointer; }',
  '    button:disabled { background: #aaa; }',
  '    ul { list-style: none; margin: 0; padding: 0; }',
  '    li { background: #fff; padding: 11px 14px; border-radius: 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.06); word-break: break-word; }',
  '    .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }',
  '    .time, .device { color: #999; font-size: 12px; }',
  '    .copy { margin-left: auto; padding: 3px 10px; font-size: 12px; line-height: 1.4; border: 1px solid #ddd; border-radius: 6px; background: #fff; color: #555; cursor: pointer; transition: all .15s; }',
  '    .copy:hover { border-color: #4a90d9; color: #4a90d9; }',
  '    .copy.copied { background: #34c759; color: #fff; border-color: #34c759; }',
  '    .copy.failed { background: #ff3b30; color: #fff; border-color: #ff3b30; }',
  '    .content { display: block; white-space: pre-wrap; }',
  '  </style>',
  '</head>',
  '<body>',
  '  <div class="wrap">',
  '    <h1>lanyell</h1>',
  '    <span class="status" id="status">connecting…</span>',
  '    <form id="f">',
  '      <textarea id="m" placeholder="Type a message, Enter to send…" autocomplete="off" autofocus rows="1"></textarea>',
  '      <button type="submit">Send</button>',
  '    </form>',
  '    <ul id="list"></ul>',
  '  </div>',
  '  <script>',
  '    const list = document.getElementById("list");',
  '    const form = document.getElementById("f");',
  '    const input = document.getElementById("m");',
  '    const status = document.getElementById("status");',
  '',
  '    // Auto-grow: reset to 0 then set height = scrollHeight. The CSS max-height',
  '    // caps growth at ~4 lines and keeps overflow internal, so padding never',
  '    // disappears (do NOT recompute a JS ceiling — that drifts and eats padding).',
  '    function autoGrow() {',
  '      input.style.height = "44px";',
  '      input.style.height = input.scrollHeight + "px";',
  '    }',
  '    input.addEventListener("input", autoGrow);',
  '',
  '    // Enter to send, Shift+Enter for a newline',
  '    input.addEventListener("keydown", function (ev) {',
  '      if (ev.key === "Enter" && !ev.shiftKey) {',
  '        ev.preventDefault();',
  '        form.requestSubmit();',
  '      }',
  '    });',
  '',
  '    // Detect real OS: prefer userAgentData (new API, Chromium), fall back to UA string',
  '    function detectOs() {',
  '      if (navigator.userAgentData && navigator.userAgentData.platform) {',
  '        const p = navigator.userAgentData.platform.toLowerCase();',
  '        if (p === "ios") return "iOS";',
  '        if (p === "android") return "Android";',
  '        if (p === "macos") return "macOS";',
  '        if (p === "windows") return "Windows";',
  '        if (p === "linux") return "Linux";',
  '      }',
  '      const ua = navigator.userAgent;',
  '      if (/iPhone|iPad|iPod/.test(ua)) return "iOS";',
  '      if (/Android/.test(ua)) return "Android";',
  '      if (/Mac OS X|Macintosh/.test(ua)) return "macOS";',
  '      if (/Windows/.test(ua)) return "Windows";',
  '      if (/Linux/.test(ua)) return "Linux";',
  '      return "Web";',
  '    }',
  '',
  '    // Device id: OS prefix (real system) + a localStorage-persisted random short',
  '    // segment (tells browser instances apart). Browsers expose no MAC/hardware id,',
  '    // so this is the environment ceiling.',
  '    const DEVICE_KEY = "lanyell_device_id";',
  '    function getDeviceId() {',
  '      const os = detectOs();',
  '      const rand = (crypto.randomUUID ? crypto.randomUUID() : "id" + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 6);',
  '      const id = os + "-" + rand;',
  '      try {',
  '        const stored = localStorage.getItem(DEVICE_KEY);',
  '        if (stored) return stored;',
  '        localStorage.setItem(DEVICE_KEY, id);',
  '        return id;',
  '      } catch (e) {',
  '        // localStorage unavailable (private mode, etc.): keep an in-memory var',
  '        if (!window.__lanyellDeviceId) window.__lanyellDeviceId = id;',
  '        return window.__lanyellDeviceId;',
  '      }',
  '    }',
  '    const deviceId = getDeviceId();',
  '',
  '    // Copy text: clipboard API needs a secure context (HTTPS/localhost); on LAN',
  '    // http it is undefined, so fall back to execCommand (deprecated but the only',
  '    // path that works over plain http).',
  '    function copyText(text) {',
  '      if (navigator.clipboard && navigator.clipboard.writeText) {',
  '        return navigator.clipboard.writeText(text);',
  '      }',
  '      return new Promise(function (resolve, reject) {',
  '        const ta = document.createElement("textarea");',
  '        ta.value = text;',
  '        ta.style.position = "fixed";',
  '        ta.style.opacity = "0";',
  '        document.body.appendChild(ta);',
  '        ta.select();',
  '        try {',
  '          document.execCommand("copy") ? resolve() : reject(new Error("copy failed"));',
  '        } catch (e) {',
  '          reject(e);',
  '        } finally {',
  '          document.body.removeChild(ta);',
  '        }',
  '      });',
  '    }',
  '',
  '    // Render one message (textContent everywhere to prevent XSS)',
  '    function render(msg) {',
  '      const li = document.createElement("li");',
  '      li.style.background = msg.color || "#fff";',
  '      const meta = document.createElement("div");',
  '      meta.className = "meta";',
  '      const time = document.createElement("span");',
  '      time.className = "time";',
  '      time.textContent = new Date(msg.time).toLocaleTimeString();',
  '      const device = document.createElement("span");',
  '      device.className = "device";',
  '      device.textContent = msg.device;',
  '      const copy = document.createElement("button");',
  '      copy.className = "copy";',
  '      copy.type = "button";',
  '      copy.textContent = "Copy";',
  '      copy.addEventListener("click", function () {',
  '        copyText(msg.content).then(function () {',
  '          copy.textContent = "\\u2713 Copied";',
  '          copy.classList.add("copied");',
  '          setTimeout(function () {',
  '            copy.textContent = "Copy";',
  '            copy.classList.remove("copied");',
  '          }, 1500);',
  '        }).catch(function () {',
  '          copy.textContent = "\\u2717 Failed";',
  '          copy.classList.add("failed");',
  '          setTimeout(function () {',
  '            copy.textContent = "Copy";',
  '            copy.classList.remove("failed");',
  '          }, 1500);',
  '        });',
  '      });',
  '      meta.appendChild(time);',
  '      meta.appendChild(device);',
  '      meta.appendChild(copy);',
  '      li.appendChild(meta);',
  '      const content = document.createElement("span");',
  '      content.className = "content";',
  '      content.textContent = msg.content;',
  '      li.appendChild(content);',
  '      list.prepend(li); // newest on top',
  '    }',
  '',
  '    // SSE: stream new messages live (browser auto-reconnects)',
  '    const es = new EventSource("/events");',
  '    es.onopen = function () { status.textContent = "connected"; };',
  '    es.onerror = function () { status.textContent = "reconnecting…"; };',
  '    es.onmessage = function (e) { render(JSON.parse(e.data)); };',
  '',
  '    // Submit on Enter or button click',
  '    form.addEventListener("submit", async function (ev) {',
  '      ev.preventDefault();',
  '      const content = input.value.trim();',
  '      if (!content) return;',
  '      input.value = "";',
  '      autoGrow(); // collapse height after clearing',
  '      input.disabled = true;',
  '      try {',
  '        const r = await fetch("/send", {',
  '          method: "POST",',
  '          headers: { "Content-Type": "application/json" },',
  '          body: JSON.stringify({ content: content, device: deviceId })',
  '        });',
  '        if (!r.ok) throw new Error((await r.json()).error || "send failed");',
  '      } catch (err) {',
  '        input.value = content;',
  '        autoGrow();',
  '        alert(err.message);',
  '      } finally {',
  '        input.disabled = false;',
  '        input.focus();',
  '      }',
  '    });',
  '  <\/script>',
  '</body>',
  '</html>'
].join('\n');

// Read the request body as text
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Broadcast one message to every connected client
function broadcast(msg) {
  const frame = sseFrame(msg);
  for (const res of clients) {
    res.write(frame);
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const url = req.url;

  // Home page
  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // SSE long-poll
  if (method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    // Replay history to a newly connected client first
    for (const msg of messages) {
      res.write(sseFrame(msg));
    }
    clients.add(res);
    req.on('close', () => { clients.delete(res); });
    return;
  }

  // Send a message
  if (method === 'POST' && url === '/send') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'content is empty' }));
        return;
      }
      if (content.length > 2000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'content too long (max 2000 chars)' }));
        return;
      }
      // Device id: take the client-supplied value; if missing, derive OS from the
      // request UA + the client IP tail — never return "unknown".
      let device = typeof body.device === 'string' && body.device.trim() ? body.device.trim().slice(0, 32) : '';
      if (!device) {
        const os = parseOsFromUa(req.headers['user-agent']);
        const ipTail = (req.socket.remoteAddress || '').split('.').pop() || '?';
        device = os + '-' + ipTail;
      }
      const color = colorForDevice(device);
      const msg = { id: nextId(), content: content, device: device, color: color, time: Date.now() };
      messages = [...messages, msg]; // immutable update
      broadcast(msg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server error' }));
    }
    return;
  }

  // Everything else: 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Only start the server when run directly (node server.js / npx lanyell).
// When required by tests, just export the pure helpers without listening.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('lanyell is running');
    console.log('  local:   http://localhost:' + PORT);
    console.log('  network: http://<your-LAN-IP>:' + PORT);
  });
}

module.exports = { parseOsFromUa, colorForDevice, sseFrame, DEVICE_COLORS };
