// HTTP request handler. Pure, dependency-injected: takes a store and the HTML
// string, returns an async handler (req, res) that handles every route.
// This shape makes the routing logic unit-testable without a real socket.

const { TOTAL_LIMIT } = require('./split');

// 请求体硬上限(字节):边读边累计,超限立即拒绝,防止把超大 body 完整读进内存。
// 高于 TOTAL_LIMIT 的字符数上限,给 JSON 编码开销留出余量。
const MAX_BODY_BYTES = 1024 * 1024;

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
// 上限是单次发送的总量(超过 10000 的部分由 store 自动拆成多段,不在这里管)
function validateContent(body) {
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return { error: 'content is empty', status: 400 };
  if (content.length > TOTAL_LIMIT) {
    return { error: 'content too long (max ' + TOTAL_LIMIT + ' chars)', status: 400 };
  }
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
          // 立即 destroy 会把还没送达的响应一起 RST 掉
          sendJson(res, 413, { error: 'payload too large' });
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

module.exports = { createHandler, validateContent, readBody };
