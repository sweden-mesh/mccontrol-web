#!/usr/bin/env node
// Make the deployable copy of web/: everything a browser loads, with the release's version stamped
// into sw.js and version.json, and integrity.json listing the SHA-256 of every file. The same
// directory is deployed to Cloudflare Pages and zipped for a release (.github/workflows/web-deploy.yml).
//
//   node scripts/web-dist.mjs --out dist/web --version web-v0.1.0 --commit 0123abc
//
// The offline copy (web/sw.js) installs a release only when every file matches integrity.json, and
// an owner can check a downloaded zip against it:
//   python3 -c 'import hashlib,json;m=json.load(open("integrity.json"));print([p for p,h in m["files"].items() if hashlib.sha256(open(p,"rb").read()).hexdigest()!=h] or "all files match")'
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kept out of the copy: tests, the development notes and node's package file.
const EXCLUDE = new Set(['test', 'package.json', 'README.md', 'node_modules']);

export function sourceFiles(web) {
  const walk = (dir) => readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (dir === web && EXCLUDE.has(name)) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  return walk(web).map((p) => relative(web, p).split(sep).join('/'));
}

export function stampWorker(source, version) {
  const line = /^const VERSION = '[^']*';$/m;
  if (!line.test(source)) throw new Error('sw.js has no VERSION line');
  return source.replace(line, `const VERSION = '${version}';`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function buildDist({ web, out, version, commit }) {
  if (!/^[\w.+-]+$/.test(version)) throw new Error(`version ${version}: letters, digits and . + - _ only`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files = sourceFiles(web);
  for (const f of files) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(join(web, f), join(out, f));
  }
  writeFileSync(join(out, 'sw.js'), stampWorker(readFileSync(join(web, 'sw.js'), 'utf8'), version));
  writeFileSync(join(out, 'version.json'), `${JSON.stringify({ version, commit: commit || null })}\n`);
  const manifest = { version, commit: commit || null, files: {} };
  for (const f of files) manifest.files[f] = sha256(readFileSync(join(out, f)));
  writeFileSync(join(out, 'integrity.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { out, version, commit } = args(process.argv.slice(2));
  if (!out || !version) {
    console.error('usage: web-dist.mjs --out DIR --version VERSION [--commit SHA]');
    process.exit(2);
  }
  const web = fileURLToPath(new URL('../web', import.meta.url));
  const m = buildDist({ web, out, version, commit });
  console.log(`${out}: ${Object.keys(m.files).length} files, ${version}`);
}
