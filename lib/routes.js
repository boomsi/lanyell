// HTTP request handler. Pure, dependency-injected: takes a store and the HTML
// string, returns an async handler (req, res) that handles every route.
// This shape makes the routing logic unit-testable without a real socket.

const { contentDisposition } = require('./files');

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

// 校验一条待发送的消息,返回 { content, attachments } 或 { error, status }。
// - 长度不设字符上限,超长内容由 store 自动拆成多段(唯一的发送上限是
//   readBody 的字节墙 MAX_BODY_BYTES);
// - 一条消息成立的条件是「有文字,或有附件」;
// - 附件信息一律以服务端的记录为准:客户端只报 fileIds,文件名和大小谎报不了。
function validateMessage(body, files) {
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const raw = body.fileIds === undefined || body.fileIds === null ? [] : body.fileIds;
  if (!Array.isArray(raw)) return { error: 'fileIds must be an array', status: 400 };
  // 查不到的 id 报错而不是静默丢掉:多半是附件已被回收或过期,
  // 悄悄少发一个附件比直接告诉用户更糟
  for (const id of raw) {
    if (!files.has(id)) return { error: 'unknown attachment', status: 400 };
  }
  const attachments = raw.map((id) => ({
    id: id,
    name: files.nameOf(id),
    size: files.sizeOf(id),
    type: files.typeOf(id),
  }));
  if (!content && attachments.length === 0) return { error: 'content is empty', status: 400 };
  return { content: content, attachments: attachments };
}

// URL 段解码。畸形编码(如 /messages/%zz)会让 decodeURIComponent 抛 URIError,
// 而异步 handler 里抛出去就是 unhandled rejection —— 整个进程会被一条请求打挂,
// 所以这里必须挡住,由调用方回 400。返回 null 表示这个段没解码成功。
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return null;
  }
}

// 请求头只能安全携带 latin-1,中文文件名必须先 percent 编码再放进来。
// 解不开就当没给(sanitizeName 会兜成 'file'),不影响上传本身。
function decodeHeader(value) {
  if (typeof value !== 'string') return '';
  return decodeSegment(value) || '';
}

// 顶层错误边界。
//
// 这是网络服务器的 handler:任何一处没预料到的抛出都会变成 unhandled
// rejection,而 Node 默认直接终止进程。消息又是内存态,进程一退全板消息一起丢。
// 「一条请求打死整个板子」已经真发生过两次 —— 畸形的 URL 百分号编码、
// 文件名截断把代理对劈成两半 —— 两次都是数据层的 bug,但后果都被这一层缺失
// 放大成了服务整体不可用。
//
// 这层不是用来吞错的:它把未预料的异常变成 500 加一条带栈的 stderr,
// 服务继续活着,同时留下可查的痕迹。数据 bug 该修还是要修。
function guardRoute(res, err) {
  console.error('unhandled route error:', (err && err.stack) || err);
  if (res.headersSent) {
    // 响应已经写了一部分(SSE、正在流的下载),状态码已经发出去了,只能断连接
    res.destroy();
    return;
  }
  sendJson(res, 500, { error: 'server error' });
}

// Build the request handler from injected dependencies
function createHandler(store, html, files) {
  // 路由主体:抛出去的任何异常都由下面的边界接住
  async function route(req, res) {
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
      // writeHead 本身不发送响应头,Node 会缓冲到第一次 write。空板子上
      // registerClient 没有历史可写,于是一个字节都发不出去,浏览器永远收不到
      // 响应头、EventSource 的 onopen 不触发,状态栏一直停在"connecting…"。
      // SSE 本来就要求立刻把响应头发出去,流才算是开着。
      res.flushHeaders();
      store.registerClient(res);
      req.on('close', () => { store.unregisterClient(res); });
      return;
    }

    // Send a message
    if (method === 'POST' && url === '/send') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = validateMessage(body, files);
        if (result.error) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        const device = store.resolveDevice(body, req);
        store.add(result.content, device, result.attachments);
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
      const id = decodeSegment(url.slice('/messages/'.length));
      if (!id) {
        sendJson(res, 400, { error: 'message id is required' });
        return;
      }
      const removed = store.remove(id);
      sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'message not found' });
      return;
    }

    // 上传附件:裸二进制 body,元数据走请求头。
    // 刻意不用 multipart/form-data —— 这个项目零依赖、无框架,手写 multipart
    // 边界解析是一大坨代码加一大坨 bug;把 File 直接当作 body 发是标准做法,
    // 服务端只需要把它 pipe 到磁盘,整个文件不进内存。
    // 这里只落盘、不建消息:文字和附件要一起发,建消息是 /send 的事。
    if (method === 'POST' && url === '/files') {
      try {
        const saved = await files.save(req, {
          name: decodeHeader(req.headers['x-filename']),
          type: decodeHeader(req.headers['x-file-type']),
        });
        sendJson(res, 200, saved);
      } catch (err) {
        // 单文件超限 / 磁盘预算用尽:先写出响应再断连接,和 /send 同理
        if (err.status === 413 || err.status === 507) {
          sendJson(res, err.status, { error: err.message });
          res.on('finish', () => req.destroy());
          return;
        }
        sendJson(res, 500, { error: 'server error' });
      }
      return;
    }

    // 图片内联预览。这是全站唯一一处不以 attachment 下发上传内容的地方,
    // 所以必须夹紧 —— 三条同时成立才放行:
    //   1. 类型从**文件头魔数**嗅探,绝不采信客户端报的 MIME(那正是 MIME
    //      混淆的入口,报个 image/png 实际是 HTML 就中招了);
    //   2. 只放行位图白名单,SVG 明确排除(SVG 是能带脚本的 XML,直接打开
    //      那个 URL 就是同源 XSS,而 <img> 缩略图用不到它);
    //   3. 仍然带 nosniff,不让浏览器自作主张猜类型。
    // 嗅探不出图片就 404 —— 宁可不预览,也不开这个口子。
    const PREVIEW_SUFFIX = '/preview';
    if (method === 'GET' && url.startsWith('/files/') && url.endsWith(PREVIEW_SUFFIX)) {
      const id = decodeSegment(url.slice('/files/'.length, url.length - PREVIEW_SUFFIX.length));
      const type = id ? files.previewType(id) : null;
      if (!type) {
        sendJson(res, 404, { error: 'no preview for this file' });
        return;
      }
      const stream = files.createReadStream(id);
      if (!stream) {
        sendJson(res, 404, { error: 'file not found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': files.sizeOf(id),
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      });
      stream.pipe(res);
      stream.on('error', () => res.destroy());
      return;
    }

    // 下载附件。两条响应头是安全底线,不是可选项:
    // - Content-Disposition: attachment 且一律 application/octet-stream ——
    //   让上传内容在板子的同源下内联渲染,等于给自己开一个存储型 XSS,
    //   别人传个 .html 你一点就在同源里执行脚本;
    // - X-Content-Type-Options: nosniff 阻止浏览器无视上面的类型去猜。
    if (method === 'GET' && url.startsWith('/files/')) {
      const id = decodeSegment(url.slice('/files/'.length));
      const stream = id ? files.createReadStream(id) : null;
      if (!stream) {
        sendJson(res, 404, { error: 'file not found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': files.sizeOf(id),
        'Content-Disposition': contentDisposition(files.nameOf(id)),
        'X-Content-Type-Options': 'nosniff',
      });
      stream.pipe(res);
      // 读盘失败(文件被外部删掉等)直接断连接,不要让异常冒到 handler 外面
      stream.on('error', () => res.destroy());
      return;
    }

    // Everything else: 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  return async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      guardRoute(res, err);
    }
  };
}

module.exports = { createHandler, validateMessage, readBody, decodeSegment, MAX_BODY_BYTES };
