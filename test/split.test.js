const test = require('node:test');
const assert = require('node:assert');

const { splitContent, SINGLE_PART_LIMIT, TOTAL_LIMIT } = require('../lib/split');

// 检测字符串中是否存在孤立代理对(高代理后无低代理 / 低代理前无高代理)
function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // 跳过完整的代理对
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = str.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev < 0xdc00)) return true;
    }
  }
  return false;
}

// 每段都必须 ≤ limit、无孤立代理,且拼接无损还原原文
function assertValidSplit(content, limit) {
  const parts = splitContent(content, limit);
  parts.forEach((p) => {
    assert.ok(p.length <= limit, 'each part must be within the limit');
    assert.ok(!hasLoneSurrogate(p), 'no part may contain a lone surrogate');
  });
  assert.strictEqual(parts.join(''), content, 'parts must join back to the original');
  return parts;
}

test('limits are exported as expected', () => {
  assert.strictEqual(SINGLE_PART_LIMIT, 10000);
  assert.strictEqual(TOTAL_LIMIT, 100000);
});

test('splitContent returns the content as a single part at or under the limit', () => {
  assert.deepStrictEqual(splitContent('hello', 10000), ['hello']);
  assert.deepStrictEqual(splitContent('x'.repeat(10000), 10000), ['x'.repeat(10000)]);
});

test('splitContent prefers cutting right after a newline', () => {
  // 25 行,每行 500 字符内容 + 1 个换行 = 每行 501;20 行 = 10020 > 10000,
  // 所以第一刀应落在第 19 行的换行之后(19 * 501 = 9519 ≤ 10000)
  const lines = [];
  for (let i = 0; i < 25; i++) lines.push('L' + i + 'x'.repeat(498)); // 499 内容 + 换行 = 500
  const content = lines.join('\n'); // 25 * 500 - 1 = 12499 字符
  const parts = assertValidSplit(content, 10000);
  assert.ok(parts.length >= 2, '12499 chars must split into multiple parts');
  parts.forEach((p) => {
    assert.ok(p.endsWith('\n') || p === parts[parts.length - 1], 'every non-final part must end at a line boundary');
  });
});

test('splitContent falls back to a hard char cut with no newlines', () => {
  const content = 'x'.repeat(25001);
  const parts = assertValidSplit(content, 10000);
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0].length, 10000);
  assert.strictEqual(parts[2].length, 5001);
});

test('splitContent never cuts a surrogate pair in half', () => {
  // emoji '😀' 是一个代理对(2 个 UTF-16 单元);构造使代理对恰好横跨
  // limit 边界(高位在 9999、低位在 10000),切点必须前移一位
  const content = 'x'.repeat(9999) + '😀😀' + 'y'.repeat(50);
  const parts = assertValidSplit(content, 10000);
  assert.ok(parts.length >= 2);
  assert.strictEqual(parts[0].length, 9999, 'cut must back off to avoid splitting the pair');
  assert.ok(parts[1].startsWith('😀'), 'the pair must land intact at the start of the next part');
});

test('splitContent handles a one-char overflow', () => {
  const content = 'a'.repeat(10001);
  const parts = assertValidSplit(content, 10000);
  assert.deepStrictEqual(parts, ['a'.repeat(10000), 'a']);
});

test('splitContent handles newline-only content near the limit', () => {
  // 10001 个换行:第一刀在 [0,10000) 内最后一个换行(索引 9999)之后
  const content = '\n'.repeat(10001);
  const parts = assertValidSplit(content, 10000);
  assert.strictEqual(parts[0].length, 10000);
  assert.strictEqual(parts[1].length, 1);
});
