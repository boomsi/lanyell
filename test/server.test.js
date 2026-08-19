const test = require('node:test');
const assert = require('node:assert');
const { parseOsFromUa, sseFrame, colorForDevice, DEVICE_COLORS } = require('../server.js');

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

test('sseFrame wraps a message as a valid SSE data frame', () => {
  const frame = sseFrame({ content: 'hi' });
  assert.ok(frame.startsWith('data: '));
  assert.ok(frame.endsWith('\n\n'));
  const payload = JSON.parse(frame.slice(6, -2));
  assert.strictEqual(payload.content, 'hi');
});

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
