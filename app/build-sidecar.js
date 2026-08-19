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

const triple = process.argv[2] || hostTriple();
fs.mkdirSync(binariesDir, { recursive: true });

const outfile = path.join(binariesDir, 'lanyell-server-' + triple);
console.log('compiling sidecar for ' + triple + ' -> ' + outfile);
execSync(
  'bun build --compile --target=bun-' + triple.split('-').slice(0, 2).join('-') +
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
