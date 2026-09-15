// In-memory message store with immutable updates.
// Exposed as a factory so tests can create isolated stores without touching
// the module-level state used by the running server.

const { colorForDevice } = require('./colors');
const { parseOsFromUa } = require('./device');
const { sseFrame } = require('./sse');
const { splitContent, SINGLE_PART_LIMIT } = require('./split');

// 消息存活时长:创建满 1 小时即淘汰。
// store 只增不减的话,反复粘贴长文本会把内存撑爆 —— 真正兜住内存的是这里,
// 不是请求体那道墙,所以它也是发送上限敢放宽到 8MB 的前提。
const MESSAGE_TTL_MS = 60 * 60 * 1000;
// 淘汰扫描周期:过期后最多 30 秒内被清理并广播 delete
const SWEEP_INTERVAL_MS = 30 * 1000;

// Simple unique id generator
let counter = 0;
const nextId = () => Date.now() + '-' + (counter++);

// Create an isolated store instance.
//   options.now             注入时钟(测试要把时间拨到 1 小时之后,不能真等)
//   options.ttlMs           存活时长,默认 MESSAGE_TTL_MS
//   options.sweepIntervalMs 扫描周期,<= 0 关闭定时扫描(测试用)
//   options.removeFile      (fileId) => void —— 消息被删/过期时同步清掉磁盘附件
//   options.sweepFiles      (liveIds, nowMs) => void —— 回收没人引用的附件
// 附件相关的两个能力都是注入的:store 本身不碰文件系统,测试里塞个 spy 就能验。
function createStore(options = {}) {
  const now = options.now || Date.now;
  const removeFile = options.removeFile;
  const sweepFiles = options.sweepFiles;
  const ttlMs = options.ttlMs === undefined ? MESSAGE_TTL_MS : options.ttlMs;
  const sweepIntervalMs = options.sweepIntervalMs === undefined
    ? SWEEP_INTERVAL_MS
    : options.sweepIntervalMs;

  let messages = [];
  const clients = new Set();

  // Broadcast one event object to every connected client as an SSE frame
  function broadcast(event) {
    const frame = sseFrame(event);
    for (const res of clients) {
      res.write(frame);
    }
  }

  // 内部:按 id 集合删除,并扩展到所在拆分组的全部段。
  // remove(手动删一条)与 sweep(过期淘汰)共用 —— 两者都必须整组一起删,
  // 否则会残留半组,前端按组 Copy 会拼出残缺全文。
  // Returns true if anything was removed.
  function removeByIds(ids) {
    if (ids.size === 0) return false;
    const hit = messages.filter((m) => ids.has(m.id));
    if (hit.length === 0) return false;
    const groupIds = new Set(hit.filter((m) => m.group).map((m) => m.group.id));
    const doomed = messages.filter((m) => ids.has(m.id) || (m.group && groupIds.has(m.group.id)));
    const doomedIds = new Set(doomed.map((m) => m.id));
    messages = messages.filter((m) => !doomedIds.has(m.id)); // immutable update
    // 附件只有在没有任何存活消息还引用它时才清盘。同一个 fileId 可以被多条
    // 消息引用(重复提交同一个附件是允许的),删一条就把文件删掉,另一条的
    // Download 会变成 404。
    const stillReferenced = liveFileIds();
    const dropped = new Set();
    doomed.forEach((m) => {
      if (removeFile && m.files) {
        m.files.forEach((f) => {
          if (!stillReferenced.has(f.id) && !dropped.has(f.id)) {
            dropped.add(f.id);
            removeFile(f.id); // 手动删除和一小时过期都经过这里,所以只需挂这一处
          }
        });
      }
      broadcast({ type: 'delete', id: m.id });
    });
    return true;
  }

  // 当前还被消息引用的附件 id —— 回收孤儿时要避开这些
  function liveFileIds() {
    const ids = new Set();
    for (const m of messages) {
      if (!m.files) continue;
      for (const f of m.files) ids.add(f.id);
    }
    return ids;
  }

  // 淘汰创建满 ttlMs 的消息,返回本次淘汰的条数。
  // 同一组的段共享 add 时的同一个时间戳,会被一起选中;即便不是,
  // removeByIds 也会按组扩展,不会留下半组。
  function sweep() {
    const cutoff = now() - ttlMs;
    const expired = new Set();
    for (const m of messages) {
      if (m.time <= cutoff) expired.add(m.id);
    }
    const before = messages.length;
    removeByIds(expired);
    // 附件孤儿回收:上传成功、消息却始终没发出去的附件不被任何消息引用,
    // 只能靠这里清掉(宽限期在 files.js 里,避免删掉别人正在发的那份)
    if (sweepFiles) sweepFiles(liveFileIds(), now());
    return before - messages.length;
  }

  // 淘汰必须跑在定时器上,不能靠惰性清理:页面开着不动时,过期消息也要从
  // 所有已连接的 tab 上消失,靠的正是 sweep 里的 delete 广播。
  // unref 让它不阻止进程退出(测试进程、或用户关掉服务器之后)。
  if (sweepIntervalMs > 0) {
    const timer = setInterval(sweep, sweepIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    get messages() {
      return messages;
    },
    get clients() {
      return clients;
    },
    sweep,
    // Resolve the device id: take the client value, otherwise derive OS from UA
    // + the client IP tail — never return "unknown".
    resolveDevice(body, req) {
      let device = typeof body.device === 'string' && body.device.trim() ? body.device.trim().slice(0, 32) : '';
      if (!device) {
        const os = parseOsFromUa(req.headers['user-agent']);
        const ipTail = (req.socket.remoteAddress || '').split('.').pop() || '?';
        device = os + '-' + ipTail;
      }
      return device;
    },
    // Append a new message (immutable) and broadcast "add" events to all clients.
    // content 超过单段上限时自动拆成多段:每段是独立消息,携带相同的
    // group: { id, index, total } 标记同源,前端按 group 关联显示、拼接复制。
    // 返回本次创建的消息数组(未拆分时长度为 1)。
    // attachments 为附件元数据数组 [{ id, name, size, type }]。
    // 带附件时不再拆分 —— 拆出来的后续段没有附件,只会变成没有意义的"半组"。
    add(content, device, attachments) {
      const color = colorForDevice(device);
      const hasFiles = Array.isArray(attachments) && attachments.length > 0;
      const parts = hasFiles ? [content] : splitContent(content, SINGLE_PART_LIMIT);
      // groupId 只生成一次:同一次发送的所有段共享,作为前端关联的锚点
      const groupId = parts.length > 1 ? nextId() + '-g' : null;
      let created = [];
      parts.forEach((part, index) => {
        const group = groupId
          ? { id: groupId, index: index, total: parts.length }
          : undefined;
        const msg = {
          id: nextId(),
          content: part,
          device: device,
          color: color,
          time: now(),
          ...(group ? { group: group } : {}),
          ...(hasFiles ? { files: attachments } : {}),
        };
        created = [...created, msg];
        messages = [...messages, msg]; // immutable update
        broadcast({ type: 'add', message: msg });
      });
      return created;
    },
    // Remove a message by id (immutable) and broadcast "delete" events.
    // 拆分组的任一段被删除时,整组一起删(避免残留半组导致复制出残缺全文)。
    // Returns true if a message was removed, false if the id was not found.
    remove(id) {
      return removeByIds(new Set([id]));
    },
    // Stream history to a freshly connected client (as "add" events), then register it
    registerClient(res) {
      for (const msg of messages) {
        res.write(sseFrame({ type: 'add', message: msg }));
      }
      clients.add(res);
    },
    unregisterClient(res) {
      clients.delete(res);
    },
  };
}

module.exports = { createStore, nextId, MESSAGE_TTL_MS, SWEEP_INTERVAL_MS };
