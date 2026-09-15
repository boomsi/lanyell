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

const { createApp } = require('../lib/app');

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

  // 和 CLI 走同一条接线路径,避免两个入口各接一半、漏掉依赖
  const app = createApp(html);
  const server = http.createServer(app.handler);
  // 退出时清掉附件目录(信号不会触发 'exit',必须单独挂)
  process.on('exit', () => app.files.cleanup());
  process.on('SIGINT', () => { app.files.cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { app.files.cleanup(); process.exit(143); });
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
