// SSE (Server-Sent Events) helpers: frame a message and broadcast to clients.

// Wrap one message into an SSE data frame (string concat avoids nested template literals)
function sseFrame(msg) {
  return 'data: ' + JSON.stringify(msg) + '\n\n';
}

// Broadcast one message to every connected client
function broadcast(msg, clients) {
  const frame = sseFrame(msg);
  for (const res of clients) {
    res.write(frame);
  }
}

module.exports = { sseFrame, broadcast };
