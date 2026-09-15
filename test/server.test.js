const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseOsFromUa, getLanIp } = require('../lib/device');
const { DEVICE_COLORS, colorForDevice } = require('../lib/colors');
const { sseFrame, broadcast } = require('../lib/sse');
const { createStore, MESSAGE_TTL_MS } = require('../lib/store');
const { createFileStore } = require('../lib/files');
const { createHandler, validateMessage, readBody, decodeSegment, MAX_BODY_BYTES } = require('../lib/routes');
const { createApp } = require('../lib/app');
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

// ---------- store 与附件 ----------
const FILE_META = { id: 'file-1', name: 'a.txt', size: 3, type: 'text/plain' };

test('store keeps text and attachment on one message and never splits it', () => {
  const store = createStore({ sweepIntervalMs: 0 });
  // 带附件时即使文字超长也不拆:拆出来的后续段没有附件,只会变成没意义的半组
  const created = store.add('x'.repeat(SINGLE_PART_LIMIT * 3), 'iOS-f', [FILE_META]);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].files[0].id, 'file-1');
  assert.strictEqual(created[0].group, undefined);
});

test('store deletes the attachment when its message is removed', () => {
  const dropped = [];
  const store = createStore({ sweepIntervalMs: 0, removeFile: (id) => dropped.push(id) });
  const created = store.add('hi', 'iOS-f', [FILE_META]);
  store.remove(created[0].id);
  assert.deepStrictEqual(dropped, ['file-1']);
});

test('store deletes the attachment when its message expires', () => {
  let clock = 1_000_000;
  const dropped = [];
  const store = createStore({
    now: () => clock, sweepIntervalMs: 0,
    removeFile: (id) => dropped.push(id),
  });
  store.add('hi', 'iOS-f', [FILE_META]);
  clock += MESSAGE_TTL_MS;
  store.sweep();
  assert.deepStrictEqual(dropped, ['file-1'], '消息过期时磁盘附件必须一起清掉');
});

test('store keeps an attachment another live message still references', () => {
  // 同一个 fileId 可以被多条消息引用(重复提交同一个附件是允许的)。
  // 删一条就把文件删掉的话,另一条的 Download 会变 404。
  const dropped = [];
  const store = createStore({ sweepIntervalMs: 0, removeFile: (id) => dropped.push(id) });
  const first = store.add('', 'iOS-a', [FILE_META]);
  const second = store.add('', 'iOS-b', [FILE_META]);
  store.remove(first[0].id);
  assert.deepStrictEqual(dropped, [], '还有一条消息在用,不能清盘');
  store.remove(second[0].id);
  assert.deepStrictEqual(dropped, ['file-1'], '最后一条引用消失时才清盘');
});

test('store hands the live attachment ids to the orphan sweeper', () => {
  const calls = [];
  const store = createStore({
    sweepIntervalMs: 0,
    sweepFiles: (liveIds, nowMs) => calls.push({ ids: Array.from(liveIds), nowMs: nowMs }),
  });
  const created = store.add('hi', 'iOS-f', [FILE_META]);
  store.sweep();
  assert.deepStrictEqual(calls[0].ids, ['file-1'], '还在用的附件不能被当成孤儿回收');
  store.remove(created[0].id);
  store.sweep();
  assert.deepStrictEqual(calls[1].ids, [], '消息删掉后附件就不再被引用');
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
// 只测校验逻辑时用一个假的附件表,不必真开文件存储
const NO_FILES = { has: () => false, nameOf: () => null, sizeOf: () => null, typeOf: () => null };
const filesWith = (id, meta) => ({
  has: (x) => x === id,
  nameOf: () => meta.name,
  sizeOf: () => meta.size,
  typeOf: () => meta.type,
});

test('validateMessage rejects a message with neither text nor attachment', () => {
  const r = validateMessage({ content: '   ' }, NO_FILES);
  assert.strictEqual(r.status, 400);
  assert.ok(r.error);
});

test('validateMessage has no char cap: length is bounded by the byte wall only', () => {
  // 曾经这里有第二道墙(TOTAL_LIMIT=100000 字符),它比字节墙早 5 倍触发,
  // 把一次正常的 8000 行粘贴判成「内容太长」。长度不再在这里设限。
  const r = validateMessage({ content: 'x'.repeat(500000) }, NO_FILES);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.content.length, 500000);
});

test('validateMessage accepts content in the auto-split range', () => {
  const r = validateMessage({ content: 'x'.repeat(SINGLE_PART_LIMIT + 1) }, NO_FILES);
  assert.strictEqual(r.error, undefined, 'overlong-but-under-total content is accepted and split later');
});

test('validateMessage accepts valid content', () => {
  const r = validateMessage({ content: 'hi' }, NO_FILES);
  assert.strictEqual(r.content, 'hi');
  assert.strictEqual(r.error, undefined);
  assert.deepStrictEqual(r.attachments, []);
});

test('validateMessage accepts attachments with no text', () => {
  const files = filesWith('f1', { name: 'a.txt', size: 3, type: 'text/plain' });
  const r = validateMessage({ content: '   ', fileIds: ['f1'] }, files);
  assert.strictEqual(r.error, undefined, '有附件就够了,文字可以为空');
  assert.strictEqual(r.content, '');
  assert.deepStrictEqual(r.attachments, [{ id: 'f1', name: 'a.txt', size: 3, type: 'text/plain' }]);
});

test('validateMessage keeps every attachment in order', () => {
  const files = { has: (id) => ['f1', 'f2', 'f3'].includes(id), nameOf: (id) => id + '.txt', sizeOf: () => 1, typeOf: () => 'text/plain' };
  const r = validateMessage({ content: '', fileIds: ['f3', 'f1', 'f2'] }, files);
  assert.deepStrictEqual(r.attachments.map((a) => a.id), ['f3', 'f1', 'f2'], '顺序按客户端给的来,不要重排');
});

test('validateMessage takes name and size from the server, never the client', () => {
  // 客户端在第二步谎报文件名和大小也没用 —— 一律以落盘时记录为准
  const files = filesWith('f1', { name: 'real.txt', size: 3, type: 'text/plain' });
  const r = validateMessage({ content: 'hi', fileIds: ['f1'], files: [{ name: 'fake.exe', size: 999 }] }, files);
  assert.strictEqual(r.attachments[0].name, 'real.txt');
  assert.strictEqual(r.attachments[0].size, 3);
});

test('validateMessage rejects an attachment id the server does not know', () => {
  const r = validateMessage({ content: 'hi', fileIds: ['gone'] }, NO_FILES);
  assert.strictEqual(r.status, 400);
  assert.match(r.error, /attachment/);
});

test('validateMessage rejects fileIds that is not an array', () => {
  // 曾经这里是单个 fileId 字符串,客户端拿老格式来要明确报错而不是静默丢附件
  const r = validateMessage({ content: 'hi', fileIds: 'f1' }, NO_FILES);
  assert.strictEqual(r.status, 400);
});

// ---------- routes integration over a real HTTP server ----------
// Spin up the real handler on an ephemeral port so we exercise the full path
// without touching the default 3000.
function startTestServer(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyell-test-'));
  const files = createFileStore(Object.assign({ dir: dir }, options));
  const store = createStore({
    removeFile: (id) => files.remove(id),
    sweepFiles: (liveIds, nowMs) => files.removeOrphans(liveIds, nowMs),
  });
  const handler = createHandler(store, HTML, files);
  const server = http.createServer(handler);
  // 关服务器时顺手清掉这次用的附件目录,已有的 server.close() 调用不用改
  server.on('close', () => files.cleanup());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, store, files, port: server.address().port }));
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
function rawRequest(port, method, rawPath, payload, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: rawPath,
        headers: Object.assign(
          payload ? { 'Content-Length': payload.length } : {},
          headers || {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      }
    );
    req.on('error', reject);
    req.end(payload);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyell-test-'));
  const files = createFileStore({ dir: dir });
  const handler = createHandler(createStore(), HTML, files);
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
  files.cleanup();
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

test('GET /events flushes headers immediately on an empty board', async () => {
  // 回归:writeHead 本身不发送响应头,Node 缓冲到第一次 write 才发。空板子上
  // registerClient 没有历史可写,浏览器就永远收不到响应头,EventSource 的
  // onopen 不触发,状态栏一直停在"connecting…" —— 每次重启服务器都会这样。
  const { server, port } = await startTestServer();
  let req;
  const headers = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (req) req.destroy();
      reject(new Error('2 秒内没收到响应头'));
    }, 2000);
    req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      clearTimeout(timer);
      resolve(res.headers);
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  assert.ok(headers['content-type'].includes('text/event-stream'));
  req.destroy();
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

// ---------- 应用接线（CLI 和桌面端共用同一条路径）----------
test('createApp wires a handler that serves attachments end to end', async () => {
  // 回归:两个入口(server.js / app/sidecar.js)各接一遍线时,给 createHandler
  // 加参数必然漏掉一个,而 sidecar 没有任何测试覆盖 —— 桌面端会变成上传 500、
  // 点下载直接崩进程。现在两个入口都走 createApp,这条测试覆盖的就是那条路径。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyell-test-'));
  const app = createApp(HTML, { files: { dir: dir } });
  const server = http.createServer(app.handler);
  server.on('close', () => app.files.cleanup());
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const up = await rawRequest(port, 'POST', '/files', Buffer.from('wired'), { 'X-Filename': 'a.txt' });
  assert.strictEqual(up.status, 200, '附件存储没接上的话这里会是 500');
  const { id } = JSON.parse(up.body);
  const dl = await rawRequest(port, 'GET', '/files/' + id);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.body.toString(), 'wired');
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

test('a malformed id in GET /files returns 404 and the server survives', async () => {
  const { server, port } = await startTestServer();
  const r = await rawRequest(port, 'GET', '/files/%zz');
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await fetchUrl(port, '/')).status, 200);
  server.close();
});

// ---------- 顶层错误边界 ----------
test('an unexpected throw in a route becomes a 500, not a dead process', async () => {
  // handler 里任何没预料到的抛出都会变成 unhandled rejection,Node 默认直接
  // 终止进程;而消息是内存态,进程一退全板消息一起丢。两次真实事故(畸形 URL
  // 百分号编码、文件名截断劈开代理对)都是这个机制把数据 bug 放大成了服务不可用。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyell-test-'));
  const files = createFileStore({ dir: dir });
  const store = createStore({ sweepIntervalMs: 0 });
  const realError = console.error;
  console.error = () => {}; // 这条会走真实的错误日志,静音以免污染测试输出
  const server = http.createServer(createHandler(store, HTML, files));
  try {
    store.resolveDevice = () => { throw new Error('boom'); }; // 没预料到的异常
    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    const r = await fetchUrl(port, '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    assert.strictEqual(r.status, 500, '未预料的异常要变成 500,不是崩溃');
    // 关键不是 500,而是进程还活着、后续请求照常
    assert.strictEqual((await fetchUrl(port, '/')).status, 200);
  } finally {
    console.error = realError;
    server.close();
    files.cleanup();
  }
});

// ---------- POST /files + GET /files/:id ----------
test('POST /files stores the body and reports the metadata', async () => {
  const { server, files, port } = await startTestServer();
  const payload = Buffer.from('attachment bytes');
  const r = await rawRequest(port, 'POST', '/files', payload, {
    'X-Filename': encodeURIComponent('季度报告.pdf'),
    'X-File-Type': 'application/pdf',
  });
  assert.strictEqual(r.status, 200);
  const meta = JSON.parse(r.body);
  assert.strictEqual(meta.size, payload.length);
  assert.strictEqual(meta.name, '季度报告.pdf', '中文文件名必须原样带回来');
  assert.strictEqual(files.has(meta.id), true);
  assert.strictEqual(files.totalBytes(), payload.length);
  server.close();
});

test('POST /files aborts over the per-file cap and keeps nothing', async () => {
  const { server, files, port } = await startTestServer({ maxFileBytes: 16 });
  const r = await rawRequest(port, 'POST', '/files', Buffer.alloc(64), { 'X-Filename': 'big.bin' });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(files.totalBytes(), 0, '被拒的上传不能占磁盘预算');
  server.close();
});

test('GET /files/:id returns the exact bytes as a download, never inline', async () => {
  const { server, port } = await startTestServer();
  const payload = Buffer.from('中文内容 😀 and bytes');
  const up = await rawRequest(port, 'POST', '/files', payload, {
    'X-Filename': encodeURIComponent('evil.html'),
    'X-File-Type': 'text/html',
  });
  const { id } = JSON.parse(up.body);
  const r = await rawRequest(port, 'GET', '/files/' + id);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, payload, '下载内容必须与上传字节完全一致');
  // 这三条是安全底线:上传 .html 绝不能在板子同源下被渲染执行
  assert.ok(r.headers['content-disposition'].startsWith('attachment;'), r.headers['content-disposition']);
  assert.strictEqual(r.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  server.close();
});

test('GET /files/:id 404s for an unknown id', async () => {
  const { server, port } = await startTestServer();
  assert.strictEqual((await rawRequest(port, 'GET', '/files/does-not-exist')).status, 404);
  server.close();
});

test('a message can carry text and an attachment together', async () => {
  const { server, store, port } = await startTestServer();
  const up = await rawRequest(port, 'POST', '/files', Buffer.from('xyz'), { 'X-Filename': 'a.txt' });
  const { id } = JSON.parse(up.body);
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '这是说明', fileIds: [id], device: 'macOS-file' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.messages.length, 1, '文字和附件是同一条消息');
  const msg = store.messages[0];
  assert.strictEqual(msg.content, '这是说明');
  assert.strictEqual(msg.files[0].id, id);
  assert.strictEqual(msg.files[0].name, 'a.txt');
  assert.strictEqual(msg.files[0].size, 3);
  server.close();
});

test('one message can carry several attachments, in the order sent', async () => {
  const { server, store, port } = await startTestServer();
  const ids = [];
  for (const name of ['one.txt', 'two.png', 'three.bin']) {
    const up = await rawRequest(port, 'POST', '/files', Buffer.from(name), { 'X-Filename': name });
    ids.push(JSON.parse(up.body).id);
  }
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '', fileIds: ids, device: 'macOS-file' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.messages.length, 1, '多选附件仍然是一条消息');
  assert.deepStrictEqual(store.messages[0].files.map((f) => f.name), ['one.txt', 'two.png', 'three.bin']);
  server.close();
});

test('an attachment alone is a valid message', async () => {
  const { server, store, port } = await startTestServer();
  const up = await rawRequest(port, 'POST', '/files', Buffer.from('xyz'), { 'X-Filename': 'a.txt' });
  const { id } = JSON.parse(up.body);
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '', fileIds: [id], device: 'macOS-file' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.messages[0].content, '');
  assert.strictEqual(store.messages[0].files[0].id, id);
  server.close();
});

test('POST /send rejects a fileId the server has never seen', async () => {
  const { server, store, port } = await startTestServer();
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi', fileIds: ['made-up'], device: 'macOS-file' }),
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(store.messages.length, 0);
  server.close();
});

test('POST /send rejects the whole message if any one attachment is unknown', async () => {
  // 宁可整条失败,也不要静默少发一个附件
  const { server, store, port } = await startTestServer();
  const up = await rawRequest(port, 'POST', '/files', Buffer.from('xyz'), { 'X-Filename': 'a.txt' });
  const { id } = JSON.parse(up.body);
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi', fileIds: [id, 'made-up'], device: 'macOS-file' }),
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(store.messages.length, 0);
  server.close();
});

test('deleting a message also drops its attachments from disk', async () => {
  const { server, store, files, port } = await startTestServer();
  const ids = [];
  for (const name of ['a.txt', 'b.txt']) {
    const up = await rawRequest(port, 'POST', '/files', Buffer.from('xyz'), { 'X-Filename': name });
    ids.push(JSON.parse(up.body).id);
  }
  await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: ids, device: 'macOS-file' }),
  });
  assert.strictEqual(files.totalBytes(), 6);
  await fetchUrl(port, '/messages/' + encodeURIComponent(store.messages[0].id), { method: 'DELETE' });
  ids.forEach((id) => assert.strictEqual(files.has(id), false, '消息没了附件也必须跟着没'));
  assert.strictEqual(files.totalBytes(), 0);
  server.close();
});

// ---------- GET /files/:id/preview ----------
// 最小的合法 PNG 文件头(后面补够字节数即可通过嗅探)
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

test('GET /files/:id/preview serves real images inline', async () => {
  const { server, port } = await startTestServer();
  const png = Buffer.concat([PNG_HEAD, Buffer.alloc(24, 0)]);
  const up = await rawRequest(port, 'POST', '/files', png, { 'X-Filename': 'shot.png' });
  const { id } = JSON.parse(up.body);
  const r = await rawRequest(port, 'GET', '/files/' + id + '/preview');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'image/png', '类型来自文件头嗅探');
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.deepStrictEqual(r.body, png, '预览必须逐字节等于上传内容');
  server.close();
});

test('preview type comes from the bytes, not from what the client claimed', async () => {
  // 客户端报 image/png,实际内容却不是图片 —— 必须挡住
  const { server, port } = await startTestServer();
  const fake = Buffer.from('<script>alert(document.domain)</script>');
  const up = await rawRequest(port, 'POST', '/files', fake, {
    'X-Filename': 'evil.png',
    'X-File-Type': 'image/png',
  });
  const { id } = JSON.parse(up.body);
  const r = await rawRequest(port, 'GET', '/files/' + id + '/preview');
  assert.strictEqual(r.status, 404, '内容不是图片就不能内联下发');
  server.close();
});

test('preview refuses SVG even though it is an image', async () => {
  // SVG 是能带脚本的 XML:以 image/svg+xml 内联下发,直接打开那个 URL
  // 就能在板子同源里执行脚本。缩略图用 <img>,用不到 SVG,所以直接不放行。
  const { server, port } = await startTestServer();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const up = await rawRequest(port, 'POST', '/files', svg, {
    'X-Filename': 'x.svg',
    'X-File-Type': 'image/svg+xml',
  });
  const { id } = JSON.parse(up.body);
  assert.strictEqual((await rawRequest(port, 'GET', '/files/' + id + '/preview')).status, 404);
  // 但正常下载仍然可以
  const dl = await rawRequest(port, 'GET', '/files/' + id);
  assert.strictEqual(dl.status, 200);
  assert.ok(dl.headers['content-disposition'].startsWith('attachment;'));
  server.close();
});

test('preview sniffs JPEG, GIF, WEBP and BMP', async () => {
  const { server, port } = await startTestServer();
  const cases = [
    [Buffer.concat([JPEG_HEAD, Buffer.alloc(20)]), 'image/jpeg'],
    [Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]), 'image/gif'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(12)]), 'image/webp'],
    [Buffer.concat([Buffer.from('BM'), Buffer.alloc(20)]), 'image/bmp'],
  ];
  for (const [bytes, expected] of cases) {
    const up = await rawRequest(port, 'POST', '/files', bytes, { 'X-Filename': 'x' });
    const { id } = JSON.parse(up.body);
    const r = await rawRequest(port, 'GET', '/files/' + id + '/preview');
    assert.strictEqual(r.headers['content-type'], expected, expected);
  }
  server.close();
});

test('preview 404s for a plain text file and the download route is unaffected', async () => {
  const { server, port } = await startTestServer();
  const up = await rawRequest(port, 'POST', '/files', Buffer.from('just text'), { 'X-Filename': 'a.txt' });
  const { id } = JSON.parse(up.body);
  assert.strictEqual((await rawRequest(port, 'GET', '/files/' + id + '/preview')).status, 404);
  // /preview 必须排在下载路由之前匹配,不能被它抢走
  const dl = await rawRequest(port, 'GET', '/files/' + id);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.body.toString(), 'just text');
  assert.strictEqual(dl.headers['content-type'], 'application/octet-stream');
  server.close();
});

test('preview 404s for an unknown or malformed id without killing the server', async () => {
  const { server, port } = await startTestServer();
  assert.strictEqual((await rawRequest(port, 'GET', '/files/nope/preview')).status, 404);
  assert.strictEqual((await rawRequest(port, 'GET', '/files/%zz/preview')).status, 404);
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
