const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { listenWithFallback } = require('../lib/listen');
const { parseArgs } = require('../lib/args');
const { DEFAULT_PORT } = require('../lib/args');

// 占住一个端口:listen(0) 拿系统分配的空闲端口并保持监听,返回 { server, port }
function occupyPort() {
  return new Promise((resolve) => {
    const server = http.createServer(() => {});
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('listenWithFallback resolves the port when it is free', async () => {
  const srv = http.createServer(() => {});
  const port = await listenWithFallback(srv, 0, '127.0.0.1', false);
  assert.ok(Number.isInteger(port) && port > 0);
  assert.strictEqual(srv.listening, true);
  await closeServer(srv);
});

test('listenWithFallback bumps +1 when the start port is busy and fallback is allowed', async () => {
  const busy = await occupyPort();
  const srv = http.createServer(() => {});
  // 起始端口被占,允许回退:实际端口必然 > busy.port(占用的那个不可能再用)
  const port = await listenWithFallback(srv, busy.port, '127.0.0.1', true, 3);
  assert.ok(port > busy.port && port <= busy.port + 3, 'should land on a port within the fallback range');
  assert.strictEqual(srv.listening, true);
  await closeServer(srv);
  await closeServer(busy.server);
});

test('listenWithFallback walks past several busy ports', async () => {
  const a = await occupyPort();
  // 尽量占住相邻端口:循环占到 a.port+1 也被占为止(系统分配通常给空闲端口,
  // 若 a.port+1 已被外部进程占用同样满足测试前提)
  let b = null;
  try {
    const probe = http.createServer(() => {});
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(a.port + 1, '127.0.0.1', resolve);
    });
    b = probe;
  } catch (e) {
    // a.port+1 本来就被占,无需再占
  }
  const srv = http.createServer(() => {});
  const port = await listenWithFallback(srv, a.port, '127.0.0.1', true, 10);
  assert.ok(port > a.port + 1, 'should skip both busy ports');
  await closeServer(srv);
  await closeServer(a.server);
  if (b) await closeServer(b);
});

test('listenWithFallback rejects EADDRINUSE when fallback is not allowed', async () => {
  const busy = await occupyPort();
  const srv = http.createServer(() => {});
  await assert.rejects(
    listenWithFallback(srv, busy.port, '127.0.0.1', false),
    (err) => err.code === 'EADDRINUSE' && err.message.includes(String(busy.port))
  );
  assert.strictEqual(srv.listening, false);
  await closeServer(busy.server);
});

test('listenWithFallback rejects when the whole fallback range is busy', async () => {
  const busy = await occupyPort();
  const srv = http.createServer(() => {});
  // maxTries=1:起始端口被占后没有余量,应 reject 且报出尝试范围
  await assert.rejects(
    listenWithFallback(srv, busy.port, '127.0.0.1', true, 1),
    (err) => err.code === 'EADDRINUSE'
  );
  await closeServer(busy.server);
});

test('parseArgs reports whether the port was explicitly set', () => {
  const none = parseArgs(['node', 'server.js']);
  assert.strictEqual(none.port, DEFAULT_PORT);
  assert.strictEqual(none.portExplicit, false, 'no --port flag means the default is in use');
  const flagged = parseArgs(['node', 'server.js', '--port', '8080']);
  assert.strictEqual(flagged.port, 8080);
  assert.strictEqual(flagged.portExplicit, true);
  const short = parseArgs(['node', 'server.js', '-p=9090']);
  assert.strictEqual(short.portExplicit, true);
});
