#!/usr/bin/env node
// lanyell — a LAN message board.
// Run: npx lanyell   (or: node server.js)
// Open: http://<your-LAN-IP>:3000
// How it works: GET / serves the page; POST /send stores a message;
// GET /events streams new messages to every open tab via SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const { createStore } = require('./lib/store');
const { createHandler } = require('./lib/routes');
const { getLanIp } = require('./lib/device');

const PORT = 3000;
const HOST = '0.0.0.0'; // listen on all interfaces so LAN peers can reach it

// Load the page once at startup (synchronous read keeps the handler trivial)
const HTML_PATH = path.join(__dirname, 'public', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// Create the shared store and the request handler bound to it
const store = createStore();
const handler = createHandler(store, HTML);
const server = http.createServer(handler);

// Only start the server when run directly (node server.js / npx lanyell).
// When required by tests, just export without listening.
if (require.main === module) {
  server.listen(PORT, HOST, async () => {
    const ip = getLanIp();
    const lanUrl = ip ? 'http://' + ip + ':' + PORT : null;
    console.log('lanyell is running');
    console.log('  local:   http://localhost:' + PORT);
    if (lanUrl) {
      console.log('  network: ' + lanUrl);
      // Render a terminal QR code so phones can scan to open
      try {
        const qr = await QRCode.toString(lanUrl, { type: 'terminal', small: true });
        console.log('\n' + qr);
      } catch (err) {
        console.log('  (QR code unavailable: ' + err.message + ')');
      }
    } else {
      console.log('  network: http://<your-LAN-IP>:' + PORT);
    }
  });
}

module.exports = { server, store, handler, HTML };
