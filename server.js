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

const { createApp } = require('./lib/app');
const { getLanIp } = require('./lib/device');
const { parseArgs } = require('./lib/args');
const { listenWithFallback } = require('./lib/listen');

const HOST = '0.0.0.0'; // listen on all interfaces so LAN peers can reach it

// Load the page once at startup (synchronous read keeps the handler trivial)
const HTML_PATH = path.join(__dirname, 'public', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// store / 附件存储 / 处理器都在 createApp 里装配 —— 桌面端 sidecar 走的是
// 同一个函数,两个入口不会各自漂移(lib/app.js 里有详细说明)
const app = createApp(HTML);
const { files, store, handler } = app;
const server = http.createServer(handler);

// 退出时清掉附件目录。'exit' 覆盖正常退出,两个信号覆盖 Ctrl-C / kill ——
// 信号默认不会触发 'exit',漏掉它们的话每次 Ctrl-C 都会在 /tmp 留下一个
// 可能上百兆的目录,越攒越多。
function shutdown(code) {
  files.cleanup();
  process.exit(code);
}
process.on('exit', () => files.cleanup());
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

// Only start the server when run directly (node server.js / npx lanyell).
// When required by tests, just export without listening.
if (require.main === module) {
  let port, portExplicit;
  try {
    ({ port, portExplicit } = parseArgs(process.argv));
  } catch (err) {
    console.error('error: ' + err.message);
    console.error('usage: npx lanyell [--port <1-65535>]');
    process.exit(1);
  }

  // 默认端口被占时自动 +1 找空闲端口;显式指定的端口被占则直接报错 ——
  // 用户点名的端口不能悄悄换。横幅/QR 用最终落地端口。
  listenWithFallback(server, port, HOST, !portExplicit)
    .then(async (actualPort) => {
      if (actualPort !== port) {
        console.log('note: port ' + port + ' was busy, using ' + actualPort + ' instead');
      }
      const ip = getLanIp();
      const lanUrl = ip ? 'http://' + ip + ':' + actualPort : null;
      console.log('lanyell is running');
      console.log('  local:   http://localhost:' + actualPort);
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
        console.log('  network: http://<your-LAN-IP>:' + actualPort);
      }
    })
    .catch((err) => {
      // Surface port-in-use and permission errors instead of crashing silently
      if (err.code === 'EADDRINUSE') {
        console.error('error: ' + err.message + (portExplicit ? ' Try another with --port.' : ''));
      } else if (err.code === 'EACCES') {
        console.error('error: port ' + port + ' requires root (try a port >= 1024).');
      } else {
        console.error('error: ' + err.message);
      }
      process.exit(1);
    });
}

module.exports = { server, store, handler, HTML };
