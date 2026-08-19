// HTTP request handler. Pure, dependency-injected: takes a store and the HTML
// string, returns an async handler (req, res) that handles every route.
// This shape makes the routing logic unit-testable without a real socket.

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

function sendJson(res, status, payload) {
  res.writeHead(status, JSON_TYPE);
  res.end(JSON.stringify(payload));
}

// Validate the incoming message body; returns { content } or { error, status }
function validateContent(body) {
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return { error: 'content is empty', status: 400 };
  if (content.length > 2000) return { error: 'content too long (max 2000 chars)', status: 400 };
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
