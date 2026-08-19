// UI logic: flip the switch -> ask Rust to spawn/kill the sidecar; render the
// LAN URL and a QR code once it's running.

import { invoke } from '@tauri-apps/api/core';

const switchEl = document.getElementById('switch');
const switchLabel = document.getElementById('switchLabel');
const panel = document.getElementById('panel');
const urlEl = document.getElementById('url');
const errorEl = document.getElementById('error');

let on = false;

async function flip() {
  if (on) {
    await invoke('stop_server');
    on = false;
    render();
    return;
  }
  errorEl.classList.remove('show');
  try {
    const result = await invoke('start_server');
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

// click the URL to copy it (navigator.clipboard works in Tauri webviews)
urlEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(urlEl.textContent);
  } catch (e) {
    /* clipboard may be unavailable; ignore */
  }
});
