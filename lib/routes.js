// HTTP request handler. Pure, dependency-injected: takes a store and the HTML
// string, returns an async handler (req, res) that handles every route.
// This shape makes the routing logic unit-testable without a real socket.

// 请求体硬上限(字节):边读边累计,超限立即拒绝,防止把超大 body 完整读进内存。
// 这是发送端唯一的上限 —— 字符数不再单独设限。8MB 装得下 8000 行 × 1000 字符
// 的日志(实测最坏的 8000 行 × 500 字符约 4MB),正常粘贴碰不到它;
// 它拦的是失控客户端,不是用户。
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// 报错文案给用户看的是 MB,不是字节数
const MAX_BODY_MB = Math.round(MAX_BODY_BYTES / (1024 * 1024));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 先 reject 让 handler 回 413,由 handler 决定何时断开连接
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    // Buffer.concat 后再统一转字符串:chunk 直接字符串拼接会在多字节
    // UTF-8 字符的 chunk 边界处产生乱码
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

function sendJson(res, status, payload) {
  res.writeHead(status, JSON_TYPE);
  res.end(JSON.stringify(payload));
}

// Validate the incoming message body; returns { content } or { error, status }.
// 这里只管「是不是空的」:长度不设字符上限,超长内容由 store 自动拆成多段。
// 唯一的发送上限是 readBody 的字节墙 MAX_BODY_BYTES。
function validateContent(body) {
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return { error: 'content is empty', status: 400 };
  return { content };
}

// Build the request handler from injected dependencies
function createHandler(store, html) {
  return async (req, res) => {
    const method = req.method;
    const url = req.url;

    // Home page
    if (method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // SSE long-poll
    if (method === 'GET' && url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      store.registerClient(res);
      req.on('close', () => { store.unregisterClient(res); });
      return;
    }

    // Send a message
    if (method === 'POST' && url === '/send') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = validateContent(body);
        if (result.error) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        const device = store.resolveDevice(body, req);
        store.add(result.content, device);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        if (err.status === 413) {
          // 请求体超限:先完整写出 413 响应,写出后再强断连接 ——
          // 立即 destroy 会把还没送达的响应一起 RST 掉。
          // 文案必须带上具体数值:只说"太大"用户不知道能发多大。
          sendJson(res, 413, { error: 'message too large (max ' + MAX_BODY_MB + ' MB)' });
          res.on('finish', () => req.destroy());
          return;
        }
        sendJson(res, 500, { error: 'server error' });
      }
      return;
    }

    // Delete a message by id — anyone may delete (LAN trust model)
    if (method === 'DELETE' && url.startsWith('/messages/')) {
      const id = decodeURIComponent(url.slice('/messages/'.length));
      if (!id) {
        sendJson(res, 400, { error: 'message id is required' });
        return;
      }
      const removed = store.remove(id);
      sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'message not found' });
      return;
    }

    // Everything else: 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  };
}

module.exports = { createHandler, validateContent, readBody, MAX_BODY_BYTES };
