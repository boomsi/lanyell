// Build the lanyell server sidecar binary with `bun build --compile` and place
// it under src-tauri/binaries/ with the target-triple suffix Tauri requires
// (externalBin: binaries/lanyell-server -> lanyell-server-<triple>).
// Also copies public/ into resources/ for bundling.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appDir = __dirname;
const binariesDir = path.join(appDir, 'src-tauri', 'binaries');
const resourcesDir = path.join(appDir, 'resources');

// Resolve the host target triple from rustc (e.g. aarch64-apple-darwin).
function hostTriple() {
  const out = execSync('rustc -vV').toString();
  const m = out.match(/host:\s*(\S+)/);
  if (!m) throw new Error('cannot detect host triple from rustc -vV');
  return m[1];
}

// Map a rust triple to the bun --target format (bun-darwin-arm64 etc.).
// Arch is element 0; the OS sits at index 2 in every triple layout
// (aarch64-apple-darwin, x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu).
function bunTarget(triple) {
  const parts = triple.split('-');
  const arch = parts[0] === 'aarch64' ? 'arm64' : parts[0] === 'x86_64' ? 'x64' : parts[0];
  const os = parts[2];
  return 'bun-' + os + '-' + arch;
}

const triple = process.argv[2] || hostTriple();
fs.mkdirSync(binariesDir, { recursive: true });

const outfile = path.join(binariesDir, 'lanyell-server-' + triple);
console.log('compiling sidecar for ' + triple + ' (bun target: ' + bunTarget(triple) + ') -> ' + outfile);
execSync(
  'bun build --compile --target=' + bunTarget(triple) +
  ' ' + path.join(appDir, 'sidecar.js') + ' --outfile ' + outfile,
  { stdio: 'inherit' }
);

// Copy the web assets so they ship as bundle resources.
const publicSrc = path.join(root, 'public');
const publicDst = path.join(resourcesDir, 'public');
fs.rmSync(publicDst, { recursive: true, force: true });
fs.mkdirSync(publicDst, { recursive: true });
fs.copyFileSync(path.join(publicSrc, 'index.html'), path.join(publicDst, 'index.html'));
console.log('copied public/ -> ' + publicDst);
console.log('done');
