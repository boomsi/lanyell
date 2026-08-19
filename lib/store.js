// In-memory message store with immutable updates.
// Exposed as a factory so tests can create isolated stores without touching
// the module-level state used by the running server.

const { colorForDevice } = require('./colors');
const { parseOsFromUa } = require('./device');
const { sseFrame } = require('./sse');

// Simple unique id generator
let counter = 0;
const nextId = () => Date.now() + '-' + (counter++);

// Create an isolated store instance
function createStore() {
  let messages = [];
  const clients = new Set();

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
    // Append a new message (immutable) and broadcast to all clients
    add(content, device) {
      const color = colorForDevice(device);
      const msg = { id: nextId(), content: content, device: device, color: color, time: Date.now() };
      messages = [...messages, msg]; // immutable update
      const frame = sseFrame(msg);
      for (const res of clients) {
        res.write(frame);
      }
      return msg;
    },
    // Stream history to a freshly connected client, then register it
    registerClient(res) {
      for (const msg of messages) {
        res.write(sseFrame(msg));
      }
      clients.add(res);
    },
    unregisterClient(res) {
      clients.delete(res);
    },
  };
}

module.exports = { createStore, nextId };
