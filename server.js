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
const { parseArgs } = require('./lib/args');

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
  let port;
  try {
    ({ port } = parseArgs(process.argv));
  } catch (err) {
    console.error('error: ' + err.message);
    console.error('usage: npx lanyell [--port <1-65535>]');
    process.exit(1);
  }

  server.on('error', (err) => {
    // Surface port-in-use and permission errors instead of crashing silently
    if (err.code === 'EADDRINUSE') {
      console.error('error: port ' + port + ' is already in use. Try another with --port.');
    } else if (err.code === 'EACCES') {
      console.error('error: port ' + port + ' requires root (try a port >= 1024).');
    } else {
      console.error('error: ' + err.message);
    }
    process.exit(1);
  });

  server.listen(port, HOST, async () => {
    const ip = getLanIp();
    const lanUrl = ip ? 'http://' + ip + ':' + port : null;
    console.log('lanyell is running');
    console.log('  local:   http://localhost:' + port);
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
      console.log('  network: http://<your-LAN-IP>:' + port);
    }
  });
}

module.exports = { server, store, handler, HTML };
