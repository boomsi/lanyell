const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
  createFileStore,
  sanitizeName,
  contentDisposition,
  isSafeId,
  ORPHAN_GRACE_MS,
} = require('../lib/files');

// 每个测试用自己的目录,结束后删掉,互不干扰
function makeStore(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanyell-test-'));
  const store = createFileStore(Object.assign({ dir: dir }, options));
  return { store, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// 检测字符串中是否存在孤立代理(高代理后无低代理 / 低代理前无高代理)
function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = str.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev < 0xdc00)) return true;
    }
  }
  return false;
}

// ---------- 文件名清洗 ----------
test('sanitizeName never leaves a lone surrogate when truncating', () => {
  // 回归:slice 按 UTF-16 code unit 切,会把代理对劈成两半留下孤立高位代理。
  // 而 encodeURIComponent 遇到孤立代理必然抛 URIError,下载路由是没有 try/catch
  // 的 async handler —— 抛出去就是 unhandled rejection,整个进程被带走。
  // 实测:文件名 = 199 个 a + 一个 emoji,两个未认证请求就能打死板子。
  const name = sanitizeName('a'.repeat(199) + '😀');
  assert.ok(!hasLoneSurrogate(name), '截断后残留孤立代理: ' + JSON.stringify(name));
  assert.doesNotThrow(() => contentDisposition(name), 'contentDisposition 不能抛');
});

test('sanitizeName truncates by code point, not by UTF-16 unit', () => {
  // 200 个 emoji 是 400 个 code unit。按码点截断应该完整留下 200 个字符,
  // 顺带修掉「带 emoji 的名字实际只能存一半长度」的偏差。
  const name = sanitizeName('😀'.repeat(300));
  assert.strictEqual(Array.from(name).length, 200);
  assert.ok(!hasLoneSurrogate(name));
});

test('sanitizeName strips lone surrogates that are already in the input', () => {
  // 上游 decodeURIComponent 目前挡得住这种输入,但不该把安全性建立在
  // 「上游恰好挡住了」之上 —— 输出一定能安全编码进响应头是它的契约
  assert.ok(!hasLoneSurrogate(sanitizeName('\ud83d.txt')));
  assert.ok(!hasLoneSurrogate(sanitizeName('a\udc00b.txt')));
  assert.doesNotThrow(() => contentDisposition(sanitizeName('\ud83d.txt')));
});

test('every sanitized name can be encoded into a response header', () => {
  // 属性式检查:任意输入经过 sanitizeName 之后都必须能被 encodeURIComponent 接受
  const inputs = [
    'a'.repeat(199) + '😀', '😀'.repeat(500), '\ud83d', '\udc00', 'a\ud83db', 'x\ud83d',
    '中文'.repeat(300), '', '   ', 'a'.repeat(1000), '😀'.repeat(199) + 'a😀',
  ];
  inputs.forEach((input) => {
    const name = sanitizeName(input);
    assert.ok(!hasLoneSurrogate(name), '孤立代理残留,输入: ' + JSON.stringify(input));
    assert.doesNotThrow(() => contentDisposition(name), '输入: ' + JSON.stringify(input));
  });
});

test('sanitizeName strips CR/LF and control characters', () => {
  // CR/LF 不清掉的话,文件名进响应头就是 header injection
  assert.strictEqual(sanitizeName('a\r\nb.txt'), 'ab.txt');
  assert.strictEqual(sanitizeName('a\u0000b.txt'), 'ab.txt');
  assert.strictEqual(sanitizeName('a\u001fb.txt'), 'ab.txt');
});

test('sanitizeName strips path separators', () => {
  assert.strictEqual(sanitizeName('../../etc/passwd'), '.._.._etc_passwd');
  assert.strictEqual(sanitizeName('C:\\Windows\\win.ini'), 'C:_Windows_win.ini');
});

test('sanitizeName truncates long names and falls back for empty ones', () => {
  assert.strictEqual(sanitizeName('x'.repeat(500)).length, 200);
  assert.strictEqual(sanitizeName(''), 'file');
  assert.strictEqual(sanitizeName('   '), 'file');
  assert.strictEqual(sanitizeName(undefined), 'file');
  assert.strictEqual(sanitizeName(null), 'file');
});

test('sanitizeName keeps ordinary and non-ASCII names intact', () => {
  assert.strictEqual(sanitizeName('report-2026.pdf'), 'report-2026.pdf');
  assert.strictEqual(sanitizeName('季度报告.pdf'), '季度报告.pdf');
});

// ---------- Content-Disposition ----------
test('contentDisposition always downloads, never renders inline', () => {
  // 内联渲染一个上传的 .html 就是板子同源下的存储型 XSS
  assert.ok(contentDisposition('evil.html').startsWith('attachment;'));
});

test('contentDisposition gives an ASCII fallback plus RFC 5987 UTF-8 form', () => {
  const header = contentDisposition('季度报告.pdf');
  // ASCII 回退把 4 个非 ASCII 字符逐个换成下划线,老浏览器至少拿到一个能存的名字
  assert.ok(header.includes('filename="____.pdf"'), 'ASCII 回退:' + header);
  assert.ok(header.includes("filename*=UTF-8''" + encodeURIComponent('季度报告.pdf')), header);
});

test('contentDisposition cannot be broken out of with quotes or CRLF', () => {
  const header = contentDisposition('a";\r\nX-Injected: 1\r\n.txt');
  assert.ok(!header.includes('\r'), 'header must not contain CR');
  assert.ok(!header.includes('\n'), 'header must not contain LF');
  // 引号必须在 ASCII 回退里被替换掉,不然能提前闭合 filename="..."
  const asciiPart = header.slice(0, header.indexOf('; filename*='));
  assert.strictEqual(asciiPart.split('"').length - 1, 2, 'exactly two quotes: ' + header);
});

// ---------- id 白名单 ----------
test('isSafeId accepts generated ids and rejects traversal attempts', () => {
  assert.ok(isSafeId('0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d'));
  assert.ok(!isSafeId('../../etc/passwd'));
  assert.ok(!isSafeId('a/b'));
  assert.ok(!isSafeId('a\0b'));
  assert.ok(!isSafeId(''));
  assert.ok(!isSafeId('x'.repeat(65)));
  assert.ok(!isSafeId(undefined));
  assert.ok(!isSafeId({ toString: () => 'ok' }));
});

// ---------- 落盘 ----------
test('save streams the body to disk and reports the size', async () => {
  const { store, dir, done } = makeStore();
  const payload = Buffer.from('hello attachment');
  const { id, size } = await store.save(Readable.from([payload]));
  assert.strictEqual(size, payload.length);
  assert.strictEqual(store.has(id), true);
  assert.strictEqual(store.sizeOf(id), payload.length);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, id)), payload);
  assert.strictEqual(store.totalBytes(), payload.length);
  done();
});

test('save records sanitized metadata, not the raw client values', async () => {
  const { store, done } = makeStore();
  const { id } = await store.save(Readable.from([Buffer.from('x')]), {
    name: '../../etc/pa\r\nsswd',
    type: 'text/html\r\nX-Evil: 1',
  });
  assert.strictEqual(store.nameOf(id), '.._.._etc_passwd');
  assert.strictEqual(store.typeOf(id), 'text/htmlX-Evil: 1');
  assert.strictEqual(store.sizeOf(id), 1);
  done();
});

test('createReadStream yields the stored bytes and null for unknown ids', async () => {
  const { store, done } = makeStore();
  const payload = Buffer.from('download me');
  const { id } = await store.save(Readable.from([payload]), { name: 'a.txt' });
  const chunks = [];
  for await (const chunk of store.createReadStream(id)) chunks.push(chunk);
  assert.deepStrictEqual(Buffer.concat(chunks), payload);
  assert.strictEqual(store.createReadStream('../../etc/passwd'), null);
  assert.strictEqual(store.createReadStream('nope'), null);
  done();
});

test('save never uses the client filename as a path', async () => {
  // 磁盘上的名字是服务端 id,和客户端给的 name 无关
  const { store, dir, done } = makeStore();
  const { id } = await store.save(Readable.from([Buffer.from('x')]));
  assert.strictEqual(id.includes('..'), false);
  assert.deepStrictEqual(fs.readdirSync(dir), [id]);
  done();
});

test('save is lossless across chunk boundaries', async () => {
  const { store, dir, done } = makeStore();
  const text = '中文日志😀 second line';
  const buf = Buffer.from(text, 'utf8');
  const half = Math.floor(buf.length / 2);
  const { id } = await store.save(Readable.from([buf.slice(0, half), buf.slice(half)]));
  assert.strictEqual(fs.readFileSync(path.join(dir, id), 'utf8'), text);
  done();
});

// ---------- 上限 ----------
test('save aborts over the per-file cap and leaves nothing behind', async () => {
  const { store, dir, done } = makeStore({ maxFileBytes: 10 });
  await assert.rejects(
    store.save(Readable.from([Buffer.alloc(20)])),
    (err) => err.status === 413
  );
  assert.strictEqual(store.totalBytes(), 0, '被拒的上传不能占磁盘预算');
  assert.deepStrictEqual(fs.readdirSync(dir), [], '半截文件必须删掉');
  done();
});

test('save aborts over the total disk budget', async () => {
  const { store, dir, done } = makeStore({ maxTotalBytes: 10 });
  await store.save(Readable.from([Buffer.alloc(10)]));
  await assert.rejects(
    store.save(Readable.from([Buffer.alloc(1)])),
    (err) => err.status === 507
  );
  assert.strictEqual(store.totalBytes(), 10, '超预算的那次不能计入');
  assert.strictEqual(fs.readdirSync(dir).length, 1);
  done();
});

test('save accepts a file exactly at the cap', async () => {
  const { store, done } = makeStore({ maxFileBytes: 10 });
  const { size } = await store.save(Readable.from([Buffer.alloc(10)]));
  assert.strictEqual(size, 10);
  done();
});

// ---------- 删除 ----------
test('remove deletes the bytes and the bookkeeping', async () => {
  const { store, dir, done } = makeStore();
  const { id } = await store.save(Readable.from([Buffer.from('x')]));
  assert.strictEqual(store.remove(id), true);
  assert.strictEqual(store.has(id), false);
  assert.strictEqual(store.totalBytes(), 0);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(store.remove(id), false, '重复删除返回 false');
  done();
});

test('remove refuses an unsafe id', async () => {
  const { store, done } = makeStore();
  assert.strictEqual(store.remove('../../etc/passwd'), false);
  assert.strictEqual(store.has('../../etc/passwd'), false);
  assert.strictEqual(store.sizeOf('../../etc/passwd'), null);
  done();
});

// ---------- 孤儿回收 ----------
test('removeOrphans keeps unreferenced files inside the grace period', async () => {
  // 上传完到消息发到之间有一段网络往返,这个窗口内回收会删掉别人正在发的附件
  const { store, done } = makeStore();
  const { id } = await store.save(Readable.from([Buffer.from('x')]));
  const removed = store.removeOrphans(new Set(), Date.now());
  assert.strictEqual(removed, 0);
  assert.strictEqual(store.has(id), true);
  done();
});

test('removeOrphans reclaims unreferenced files past the grace period', async () => {
  const { store, dir, done } = makeStore();
  const { id } = await store.save(Readable.from([Buffer.from('x')]));
  const removed = store.removeOrphans(new Set(), Date.now() + ORPHAN_GRACE_MS + 1);
  assert.strictEqual(removed, 1);
  assert.strictEqual(store.has(id), false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  done();
});

test('removeOrphans never touches a file a live message still references', async () => {
  const { store, done } = makeStore();
  const { id } = await store.save(Readable.from([Buffer.from('x')]));
  const removed = store.removeOrphans(new Set([id]), Date.now() + ORPHAN_GRACE_MS * 10);
  assert.strictEqual(removed, 0);
  assert.strictEqual(store.has(id), true);
  done();
});

test('cleanup wipes the whole directory', async () => {
  const { store, dir, done } = makeStore();
  await store.save(Readable.from([Buffer.from('a')]));
  await store.save(Readable.from([Buffer.from('b')]));
  store.cleanup();
  assert.strictEqual(fs.existsSync(dir), false);
  assert.strictEqual(store.totalBytes(), 0);
  done();
});
