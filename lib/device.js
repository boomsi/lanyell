// OS detection from User-Agent (server-side fallback, never returns "unknown")
// and LAN IP discovery via os.networkInterfaces().

const os = require('os');

// Parse OS from User-Agent string
function parseOsFromUa(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Web';
}

// Find the first non-internal IPv4 address (the LAN address peers can reach)
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

module.exports = { parseOsFromUa, getLanIp };
