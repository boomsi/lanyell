#!/usr/bin/env node
// Standalone server entry for the desktop app sidecar.
// The Tauri shell compiles this (plus the lib/ modules) into a single
// executable and spawns it when the user flips the switch on.
//
// Env contract with the Rust side:
//   LANYELL_PUBLIC_DIR - absolute path to the bundled public/ resources
//   LANYELL_PORT       - port to listen on (default 3000)

const http = require('http');
const path = require('path');
const fs = require('fs');

const { createStore } = require('../lib/store');
const { createHandler } = require('../lib/routes');

const PORT = parseInt(process.env.LANYELL_PORT || '3000', 10);
const HOST = '0.0.0.0';

// In the packaged app the page is a bundled resource and the Rust host passes
// its absolute path. When running straight from the repo, fall back to the
// sibling public/ directory.
const publicDir = process.env.LANYELL_PUBLIC_DIR || path.join(__dirname, '..', 'public');
const HTML_PATH = path.join(publicDir, 'index.html');

function main() {
  let html;
  try {
    html = fs.readFileSync(HTML_PATH, 'utf8');
  } catch (err) {
    console.error('cannot read ' + HTML_PATH + ': ' + err.message);
    process.exit(1);
  }

  const store = createStore();
  const server = http.createServer(createHandler(store, html));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('port ' + PORT + ' is already in use');
      process.exit(2);
    } else {
      console.error('server error: ' + err.message);
      process.exit(3);
    }
  });
  server.listen(PORT, HOST, () => {
    // stdout line consumed by the Rust host to confirm startup
    console.log('lanyell-server listening on port ' + PORT);
  });
}

main();
