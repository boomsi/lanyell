// In-memory message store with immutable updates.
// Exposed as a factory so tests can create isolated stores without touching
// the module-level state used by the running server.

const { colorForDevice } = require('./colors');
const { parseOsFromUa } = require('./device');
const { sseFrame } = require('./sse');
const { splitContent, SINGLE_PART_LIMIT } = require('./split');

// Simple unique id generator
let counter = 0;
const nextId = () => Date.now() + '-' + (counter++);

// Create an isolated store instance
function createStore() {
  let messages = [];
  const clients = new Set();

  // Broadcast one event object to every connected client as an SSE frame
  function broadcast(event) {
    const frame = sseFrame(event);
    for (const res of clients) {
      res.write(frame);
    }
  }

  return {
    get messages() {
      return messages;
    },
    get clients() {
      return clients;
    },
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
    add(content, device) {
      const color = colorForDevice(device);
      const parts = splitContent(content, SINGLE_PART_LIMIT);
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
          time: Date.now(),
          ...(group ? { group: group } : {}),
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
      const target = messages.find((m) => m.id === id);
      if (!target) return false;
      const doomed = target.group
        ? messages.filter((m) => m.group && m.group.id === target.group.id)
        : [target];
      const doomedIds = new Set(doomed.map((m) => m.id));
      messages = messages.filter((m) => !doomedIds.has(m.id)); // immutable update
      doomed.forEach((m) => broadcast({ type: 'delete', id: m.id }));
      return true;
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

module.exports = { createStore, nextId };
