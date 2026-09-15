const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { parseOsFromUa, getLanIp } = require('../lib/device');
const { DEVICE_COLORS, colorForDevice } = require('../lib/colors');
const { sseFrame, broadcast } = require('../lib/sse');
const { createStore, MESSAGE_TTL_MS } = require('../lib/store');
const { createHandler, validateContent, readBody, decodeSegment, MAX_BODY_BYTES } = require('../lib/routes');
const { SINGLE_PART_LIMIT } = require('../lib/split');
const { parseArgs, parsePort, DEFAULT_PORT } = require('../lib/args');
const { HTML } = require('../server.js');

// ---------- lib/device ----------
test('parseOsFromUa detects common platforms', () => {
  assert.strictEqual(parseOsFromUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'iOS');
  assert.strictEqual(parseOsFromUa('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'iOS');
  assert.strictEqual(parseOsFromUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'), 'macOS');
  assert.strictEqual(parseOsFromUa('Mozilla/5.0 (Windows NT 10.0; Win64)'), 'Windows');
  assert.strictEqual(parseOsFromUa('Mozilla/5.0 (Linux; Android 14)'), 'Android');
  assert.strictEqual(parseOsFromUa('Mozilla/5.0 (X11; Linux x86_64)'), 'Linux');
  assert.strictEqual(parseOsFromUa(''), 'Unknown');
  assert.strictEqual(parseOsFromUa(undefined), 'Unknown');
});

test('getLanIp returns a string or null on this host', () => {
  const ip = getLanIp();
  assert.ok(ip === null || /^\d+\.\d+\.\d+\.\d+$/.test(ip), 'LAN IP must be an IPv4 string or null');
});

// ---------- lib/colors ----------
test('colorForDevice reuses the same color for one device', () => {
  const first = colorForDevice('device-reuse-test');
  const second = colorForDevice('device-reuse-test');
  assert.strictEqual(first, second);
});

test('colorForDevice assigns distinct palette colors to new devices', () => {
  const a = colorForDevice('fresh-device-A');
  const b = colorForDevice('fresh-device-B');
  assert.ok(DEVICE_COLORS.includes(a), 'color should come from the palette');
  assert.ok(DEVICE_COLORS.includes(b), 'color should come from the palette');
  assert.notStrictEqual(a, b, 'two different devices should not share a color');
});

// ---------- lib/sse ----------
test('sseFrame wraps a message as a valid SSE data frame', () => {
  const frame = sseFrame({ content: 'hi' });
  assert.ok(frame.startsWith('data: '));
  assert.ok(frame.endsWith('\n\n'));
  const payload = JSON.parse(frame.slice(6, -2));
  assert.strictEqual(payload.content, 'hi');
});

test('broadcast writes the frame to every client', () => {
  const writes = [];
  const fakeClients = [{ write: (s) => writes.push(s) }, { write: (s) => writes.push(s) }];
  broadcast({ content: 'hi' }, fakeClients);
  assert.strictEqual(writes.length, 2);
  assert.ok(writes[0].startsWith('data: '));
});

// ---------- lib/store ----------
test('store.add appends a message and broadcasts an "add" event', () => {
  const store = createStore();
  let written = null;
  // a fake SSE response that records what gets written
  const fakeRes = { write: (s) => { written = s; } };
  store.registerClient(fakeRes);
  const created = store.add('hello', 'iOS-abcd1234');
  assert.strictEqual(store.messages.length, 1);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].content, 'hello');
  assert.strictEqual(created[0].device, 'iOS-abcd1234');
  assert.ok(created[0].color, 'message must carry a color');
  assert.strictEqual(created[0].group, undefined, 'a single message carries no group');
  // broadcast must be a typed "add" event wrapping the message
  const event = JSON.parse(written.slice(6, -2));
  assert.strictEqual(event.type, 'add');
  assert.strictEqual(event.message.content, 'hello');
});

test('store.add splits overlong content into a linked group of parts', () => {
  const store = createStore();
  const writes = [];
  const fakeRes = { write: (s) => writes.push(s) };
  store.registerClient(fakeRes);
  const content = 'x'.repeat(SINGLE_PART_LIMIT * 2 + 1); // 20001 -> 3 parts
  const created = store.add(content, 'macOS-split');
  assert.strictEqual(store.messages.length, 3);
  assert.strictEqual(created.length, 3);
  assert.strictEqual(created.map((m) => m.content).join(''), content, 'parts must join back losslessly');
  // every part carries the same group marker with correct index/total
  const gid = created[0].group.id;
  created.forEach((m, i) => {
    assert.strictEqual(m.group.id, gid);
    assert.strictEqual(m.group.index, i);
    assert.strictEqual(m.group.total, 3);
  });
  // one SSE frame per part, in part order
  assert.strictEqual(writes.length, 3);
  const events = writes.map((w) => JSON.parse(w.slice(6, -2)));
  assert.strictEqual(events[0].message.group.index, 0);
  assert.strictEqual(events[2].message.group.index, 2);
});

test('store.remove on one part deletes the whole group', () => {
  const store = createStore();
  const created = store.add('x'.repeat(SINGLE_PART_LIMIT + 1), 'iOS-group-del'); // 2 parts
  assert.strictEqual(store.messages.length, 2);
  assert.strictEqual(store.remove(created[1].id), true); // delete the second part
  assert.strictEqual(store.messages.length, 0, 'the entire group must be removed');
});

test('store.remove deletes by id and broadcasts a "delete" event', () => {
  const store = createStore();
  let written = null;
  const fakeRes = { write: (s) => { written = s; } };
  store.registerClient(fakeRes);
  const created = store.add('hello', 'iOS-abcd1234');
  written = null;
  const removed = store.remove(created[0].id);
  assert.strictEqual(removed, true);
  assert.strictEqual(store.messages.length, 0);
  const event = JSON.parse(written.slice(6, -2));
  assert.strictEqual(event.type, 'delete');
  assert.strictEqual(event.id, created[0].id);
});

test('store.remove returns false for an unknown id', () => {
  const store = createStore();
  assert.strictEqual(store.remove('nope'), false);
});

// ---------- store TTL 淘汰 ----------
test('the message TTL is one hour', () => {
  assert.strictEqual(MESSAGE_TTL_MS, 60 * 60 * 1000);
});

test('store.sweep keeps messages younger than the TTL', () => {
  let clock = 1_000_000;
  const store = createStore({ now: () => clock, sweepIntervalMs: 0 });
  store.add('fresh', 'iOS-fresh');
  clock += MESSAGE_TTL_MS - 1;
  assert.strictEqual(store.sweep(), 0);
  assert.strictEqual(store.messages.length, 1);
});

test('store.sweep drops expired messages and broadcasts a delete for each', () => {
  let clock = 1_000_000;
  const store = createStore({ now: () => clock, sweepIntervalMs: 0 });
  const writes = [];
  store.registerClient({ write: (s) => writes.push(s) });
  store.add('old', 'iOS-old');
  clock += MESSAGE_TTL_MS;
  store.add('new', 'iOS-new');
  assert.strictEqual(store.sweep(), 1, 'only the expired message is swept');
  assert.strictEqual(store.messages.length, 1);
  assert.strictEqual(store.messages[0].content, 'new');
  // 必须广播 delete:否则已经打开的 tab 上那条过期消息永远不消失
  const deletes = writes.map((w) => JSON.parse(w.slice(6, -2))).filter((e) => e.type === 'delete');
  assert.strictEqual(deletes.length, 1);
});

test('store.sweep drops a split group as a unit, never a half group', () => {
  let clock = 5_000_000;
  const store = createStore({ now: () => clock, sweepIntervalMs: 0 });
  const writes = [];
  store.registerClient({ write: (s) => writes.push(s) });
  store.add('x'.repeat(SINGLE_PART_LIMIT + 1), 'iOS-grp'); // 2 段
  assert.strictEqual(store.messages.length, 2);
  clock += MESSAGE_TTL_MS;
  assert.strictEqual(store.sweep(), 2);
  assert.strictEqual(store.messages.length, 0, '整组一起过期,不留半组');
  const deletes = writes.map((w) => JSON.parse(w.slice(6, -2))).filter((e) => e.type === 'delete');
  assert.strictEqual(deletes.length, 2, '每一段都要广播 delete,否则叠边还留在页面上');
});

test('store sweeps on its own timer, with no request to trigger it', async () => {
  let clock = 9_000_000;
  const store = createStore({ now: () => clock, ttlMs: 20, sweepIntervalMs: 10 });
  store.add('old', 'iOS-timer');
  clock += 1000; // 把时钟拨过 TTL
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.strictEqual(store.messages.length, 0, '定时器必须自己扫,不能等下一次发送');
});

test('store.resolveDevice derives OS+IP tail when device is missing', () => {
  const store = createStore();
  const fakeReq = {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)' },
    socket: { remoteAddress: '192.168.1.42' },
  };
  const device = store.resolveDevice({}, fakeReq);
  assert.strictEqual(device, 'macOS-42');
});

test('store.resolveDevice keeps a client-supplied device id', () => {
  const store = createStore();
  const fakeReq = { headers: {}, socket: { remoteAddress: '' } };
  const device = store.resolveDevice({ device: 'iOS-aa11bb22cc33' }, fakeReq);
  assert.strictEqual(device, 'iOS-aa11bb22cc33');
});

// ---------- lib/routes (pure validation) ----------
test('validateContent rejects empty content', () => {
  const r = validateContent({ content: '   ' });
  assert.strictEqual(r.status, 400);
  assert.ok(r.error);
});

test('validateContent has no char cap: length is bounded by the byte wall only', () => {
  // 曾经这里有第二道墙(TOTAL_LIMIT=100000 字符),它比字节墙早 5 倍触发,
  // 把一次正常的 8000 行粘贴判成「内容太长」。长度不再在这里设限。
  const r = validateContent({ content: 'x'.repeat(500000) });
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.content.length, 500000);
});

test('validateContent accepts content in the auto-split range', () => {
  const r = validateContent({ content: 'x'.repeat(SINGLE_PART_LIMIT + 1) });
  assert.strictEqual(r.error, undefined, 'overlong-but-under-total content is accepted and split later');
});

test('validateContent accepts valid content', () => {
  const r = validateContent({ content: 'hi' });
  assert.strictEqual(r.content, 'hi');
  assert.strictEqual(r.error, undefined);
});

// ---------- routes integration over a real HTTP server ----------
// Spin up the real handler on an ephemeral port so we exercise the full path
// without touching the default 3000.
function startTestServer() {
  const store = createStore();
  const handler = createHandler(store, HTML);
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, store, port: server.address().port }));
  });
}

function fetchUrl(port, path, options) {
  const url = 'http://127.0.0.1:' + port + path;
  return fetch(url, options).then(async (r) => ({
    status: r.status,
    body: await r.text(),
  }));
}

// 裸 http 请求:路径原样发出,不被 fetch 的 URL 解析器改写 ——
// 测畸形百分号编码必须走这条,否则测不到真正到服务端的那个 path
function rawRequest(port, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET / returns the HTML page', async () => {
  const { server, port } = await startTestServer();
  const r = await fetchUrl(port, '/');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('lanyell'), 'page must contain the app name');
  assert.ok(r.body.includes('EventSource'), 'page must wire up SSE');
  server.close();
});

test('POST /send stores the message and returns ok', async () => {
  const { server, store, port } = await startTestServer();
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello world', device: 'macOS-test' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).ok, true);
  assert.strictEqual(store.messages.length, 1);
  assert.strictEqual(store.messages[0].content, 'hello world');
  server.close();
});

test('POST /send with empty content returns 400', async () => {
  const { server, port } = await startTestServer();
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '   ' }),
  });
  assert.strictEqual(r.status, 400);
  assert.ok(JSON.parse(r.body).error);
  server.close();
});

test('POST /send with overlong content auto-splits into linked parts', async () => {
  const { server, store, port } = await startTestServer();
  const content = 'line-' + 'x'.repeat(495) + '\n';
  const full = content.repeat(21); // 21 lines * 500 = 10500 chars -> 2 parts
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: full, device: 'macOS-split' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).ok, true);
  assert.ok(store.messages.length >= 2, 'overlong content must be stored as multiple parts');
  assert.strictEqual(store.messages.map((m) => m.content).join(''), full.trim());
  const gid = store.messages[0].group.id;
  store.messages.forEach((m) => assert.strictEqual(m.group.id, gid));
  server.close();
});

// 回归:修复前这份内容撞的是 100000 字符上限(报文只有 496KB,离字节墙还远),
// 也就是用户看到的 "content too long (max 100000 chars)"
test('POST /send accepts an 8000-line log that used to hit the char cap', async () => {
  const { server, store, port } = await startTestServer();
  const lines = [];
  for (let i = 0; i < 8000; i++) {
    const head = '2026-09-14T10:00:00.000Z INFO  [worker-' + (i % 8) + '] ';
    lines.push((head + 'x'.repeat(60)).slice(0, 60));
  }
  const full = lines.join('\n'); // 8000 * 60 + 7999 = 487999 字符
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: full, device: 'macOS-big' }),
  });
  assert.strictEqual(r.status, 200, 'an ~490KB log must be accepted');
  assert.ok(store.messages.length > 1, 'it must be stored as multiple parts');
  assert.strictEqual(store.messages.map((m) => m.content).join(''), full, 'parts must join back to the original');
  const gid = store.messages[0].group.id;
  store.messages.forEach((m) => assert.strictEqual(m.group.id, gid));
  server.close();
});

// readBody 的流式上限直接在纯函数层验证(集成层客户端行为随断连时序波动)
test('readBody rejects a body stream over the byte cap with a 413-marked error', async () => {
  const { EventEmitter } = require('node:events');
  const fakeReq = new EventEmitter();
  fakeReq.destroy = () => { fakeReq.destroyed = true; };
  const pending = readBody(fakeReq);
  fakeReq.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1));
  await assert.rejects(pending, (err) => err.status === 413);
});

// 字符墙删掉之后,413 是唯一的超限报错 —— 它必须带上具体数值,
// 否则用户只知道"太大",不知道能发多大(旧文案 'payload too large' 就是这个毛病)
test('an oversized body returns 413 naming the byte limit', async () => {
  const { EventEmitter } = require('node:events');
  const handler = createHandler(createStore(), HTML);
  const fakeReq = new EventEmitter();
  fakeReq.method = 'POST';
  fakeReq.url = '/send';
  fakeReq.headers = {};
  fakeReq.destroy = () => {};
  let status = 0;
  let body = '';
  const fakeRes = {
    writeHead(code) { status = code; },
    end(chunk) { body = chunk; },
    on() {},
  };
  const pending = handler(fakeReq, fakeRes);
  fakeReq.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1));
  fakeReq.emit('end');
  await pending;
  assert.strictEqual(status, 413);
  const maxMb = MAX_BODY_BYTES / (1024 * 1024);
  assert.strictEqual(JSON.parse(body).error, 'message too large (max ' + maxMb + ' MB)');
});

test('readBody decodes multi-byte characters split across chunks', async () => {
  const { EventEmitter } = require('node:events');
  const fakeReq = new EventEmitter();
  const text = '中文日志😀';
  const buf = Buffer.from(text, 'utf8');
  // 在多字节字符中间切开两个 chunk:字符串拼接会产生乱码,Buffer.concat 不会
  const half = Math.floor(buf.length / 2);
  const pending = readBody(fakeReq);
  fakeReq.emit('data', buf.slice(0, half));
  fakeReq.emit('data', buf.slice(half));
  fakeReq.emit('end');
  assert.strictEqual(await pending, text);
});

test('POST /send without device derives one from the request UA', async () => {
  const { server, store, port } = await startTestServer();
  await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' },
    body: JSON.stringify({ content: 'no device here' }),
  });
  assert.strictEqual(store.messages[0].device, 'iOS-1', 'loopback IP 127.0.0.1 -> tail 1');
  server.close();
});

test('unknown route returns 404', async () => {
  const { server, port } = await startTestServer();
  const r = await fetchUrl(port, '/nope');
  assert.strictEqual(r.status, 404);
  server.close();
});

// ---------- DELETE /messages/:id ----------
test('DELETE /messages/:id removes the message', async () => {
  const { server, store, port } = await startTestServer();
  await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'to be deleted', device: 'macOS-del' }),
  });
  const id = store.messages[0].id;
  const r = await fetchUrl(port, '/messages/' + encodeURIComponent(id), { method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).ok, true);
  assert.strictEqual(store.messages.length, 0, 'message must be removed from the store');
  server.close();
});

test('DELETE a non-existent id returns 404', async () => {
  const { server, port } = await startTestServer();
  const r = await fetchUrl(port, '/messages/does-not-exist', { method: 'DELETE' });
  assert.strictEqual(r.status, 404);
  server.close();
});

// ---------- 畸形 URL 不能再打挂进程 ----------
// 回归:decodeURIComponent 抛出的 URIError 在异步 handler 里就是 unhandled
// rejection,Node 直接终止进程 —— 局域网里任何一条 /messages/%zz 就能干掉整个板子。
test('decodeSegment returns null instead of throwing on malformed escapes', () => {
  assert.strictEqual(decodeSegment('%zz'), null);
  assert.strictEqual(decodeSegment('%'), null);
  assert.strictEqual(decodeSegment('%E4%B8'), null, '截断的多字节序列也算畸形');
  assert.strictEqual(decodeSegment('abc'), 'abc');
  assert.strictEqual(decodeSegment('%E4%B8%AD'), '中');
});

test('a malformed id in DELETE returns 400 and the server survives', async () => {
  const { server, port } = await startTestServer();
  const r = await rawRequest(port, 'DELETE', '/messages/%zz');
  assert.strictEqual(r.status, 400);
  // 关键不是 400,而是进程还活着、后续请求照常
  assert.strictEqual((await fetchUrl(port, '/')).status, 200);
  server.close();
});

// ---------- lib/args (port parsing) ----------
test('parseArgs defaults to 3000 when no port given', () => {
  assert.strictEqual(parseArgs(['node', 'server.js']).port, DEFAULT_PORT);
});

test('parseArgs accepts --port <n> and -p <n>', () => {
  assert.strictEqual(parseArgs(['node', 'server.js', '--port', '8080']).port, 8080);
  assert.strictEqual(parseArgs(['node', 'server.js', '-p', '9090']).port, 9090);
});

test('parseArgs accepts --port=<n> and -p=<n>', () => {
  assert.strictEqual(parseArgs(['node', 'server.js', '--port=8080']).port, 8080);
  assert.strictEqual(parseArgs(['node', 'server.js', '-p=9090']).port, 9090);
});

test('parseArgs throws on an out-of-range port', () => {
  assert.throws(() => parseArgs(['node', 'server.js', '--port', '99999']), /between 1 and 65535/);
  assert.throws(() => parseArgs(['node', 'server.js', '--port', '0']), /between 1 and 65535/);
});

test('parseArgs throws on a non-numeric port', () => {
  assert.throws(() => parseArgs(['node', 'server.js', '--port', 'abc']), /between 1 and 65535/);
});

test('parseArgs throws when --port has no value', () => {
  assert.throws(() => parseArgs(['node', 'server.js', '--port']), /requires a port number/);
});

test('parsePort coerces valid strings', () => {
  assert.strictEqual(parsePort('3000', '--port'), 3000);
  assert.strictEqual(parsePort('1', '--port'), 1);
  assert.strictEqual(parsePort('65535', '--port'), 65535);
});
