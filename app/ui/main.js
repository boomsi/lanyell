// UI logic: flip the switch -> ask Rust to spawn/kill the sidecar; render the
// LAN URL and a QR code once it's running. The port is editable only while
// the server is off; clicking the URL opens it in the system browser.

import { invoke } from '@tauri-apps/api/core';

const switchEl = document.getElementById('switch');
const switchLabel = document.getElementById('switchLabel');
const panel = document.getElementById('panel');
const urlEl = document.getElementById('url');
const errorEl = document.getElementById('error');
const portInput = document.getElementById('port');
const trayKeepEl = document.getElementById('trayKeep');

let on = false;

// Keep-in-menu-bar: remembered across launches. When checked, closing the
// window hides it and the app lives in the tray; quit only via the tray menu.
const TRAY_KEY = 'lanyell_tray_keep';
trayKeepEl.addEventListener('change', async () => {
  const keep = trayKeepEl.checked;
  try {
    await invoke('set_tray_keep', { keep });
    try { localStorage.setItem(TRAY_KEY, keep ? '1' : '0'); } catch (e) { /* ignore */ }
  } catch (err) {
    trayKeepEl.checked = !keep; // revert on failure
    errorEl.textContent = String(err);
    errorEl.classList.add('show');
  }
});
// restore the remembered preference on load
try {
  if (localStorage.getItem(TRAY_KEY) === '1') {
    trayKeepEl.checked = true;
    invoke('set_tray_keep', { keep: true }).catch(() => { trayKeepEl.checked = false; });
  }
} catch (e) { /* localStorage unavailable: leave unchecked */ }

// clamp the port input to 1-65535; returns the numeric port or null
function readPort() {
  const n = parseInt(portInput.value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

portInput.addEventListener('input', () => {
  // strip anything invalid typed/pasted in
  let v = portInput.value.replace(/[^0-9]/g, '');
  if (v !== '') {
    let n = parseInt(v, 10);
    if (n > 65535) { n = 65535; }
    if (n < 1) { n = 1; }
    v = String(n);
  }
  if (v !== portInput.value) portInput.value = v;
});

async function flip() {
  if (on) {
    await invoke('stop_server');
    on = false;
    render();
    return;
  }
  const port = readPort();
  if (port === null) {
    errorEl.textContent = 'Port must be a number between 1 and 65535.';
    errorEl.classList.add('show');
    return;
  }
  errorEl.classList.remove('show');
  try {
    const result = await invoke('start_server', { port });
    on = true;
    render(result.url);
  } catch (err) {
    errorEl.textContent = String(err);
    errorEl.classList.add('show');
    on = false;
    render();
  }
}

function render(url) {
  switchEl.classList.toggle('on', on);
  switchLabel.textContent = on ? 'On' : 'Off';
  panel.classList.toggle('show', on);
  portInput.disabled = on; // editable only while off
  if (on && url) {
    urlEl.textContent = url;
    drawQr(url);
  }
}

async function drawQr(text) {
  // qrcode is bundled at build time by esbuild (see package.json build script)
  const QRCode = (await import('qrcode')).default;
  await QRCode.toCanvas(document.getElementById('qr'), text, { width: 180 });
}

switchEl.addEventListener('click', flip);

// click the URL to open it in the system default browser
urlEl.addEventListener('click', () => {
  invoke('open_url', { url: urlEl.textContent });
});
