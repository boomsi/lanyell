const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { parseOsFromUa, getLanIp } = require('../lib/device');
const { DEVICE_COLORS, colorForDevice } = require('../lib/colors');
const { sseFrame, broadcast } = require('../lib/sse');
const { createStore } = require('../lib/store');
const { createHandler, validateContent } = require('../lib/routes');
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
test('store.add appends a message and broadcasts to clients', () => {
  const store = createStore();
  let written = null;
  // a fake SSE response that records what gets written
  const fakeRes = { write: (s) => { written = s; } };
  store.registerClient(fakeRes);
  const msg = store.add('hello', 'iOS-abcd1234');
  assert.strictEqual(store.messages.length, 1);
  assert.strictEqual(msg.content, 'hello');
  assert.strictEqual(msg.device, 'iOS-abcd1234');
  assert.ok(msg.color, 'message must carry a color');
  assert.ok(written && written.includes('hello'), 'client must receive the broadcast');
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

test('validateContent rejects content over 2000 chars', () => {
  const r = validateContent({ content: 'x'.repeat(2001) });
  assert.strictEqual(r.status, 400);
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

test('POST /send with overlong content returns 400', async () => {
  const { server, port } = await startTestServer();
  const r = await fetchUrl(port, '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'x'.repeat(2001) }),
  });
  assert.strictEqual(r.status, 400);
  server.close();
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
