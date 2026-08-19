// Minimal CLI argument parsing for the port option.
// Supports: --port 8080 , --port=8080 , -p 8080 , -p=8080
// No external dependency — keeps lanyell light.

const DEFAULT_PORT = 3000;

// Parse argv and return { port } or throw on an invalid value.
function parseArgs(argv) {
  const args = argv.slice(2);
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // --port=8080 / -p=8080
    const eq = a.match(/^(?:--port|-p)=(.+)$/);
    if (eq) {
      port = parsePort(eq[1], a);
      continue;
    }
    // --port 8080 / -p 8080 (value is the next arg)
    if (a === '--port' || a === '-p') {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(a + ' requires a port number');
      }
      port = parsePort(next, a);
      i++; // consume the value
      continue;
    }
    // Unknown flag — ignore rather than fail, so future options are forward-compatible
  }

  return { port };
}

// Validate and coerce a port string into a number 1..65535
function parsePort(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(flag + ' expects a port between 1 and 65535, got "' + raw + '"');
  }
  return n;
}

module.exports = { parseArgs, parsePort, DEFAULT_PORT };
