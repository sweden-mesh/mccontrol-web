#!/usr/bin/env node
// Copy a tag of mccontrol-spec into the places the app and its tests read it: data/*.json to
// web/lib/data/, vectors/*.json to web/test/. Every file is checked against the spec's
// MANIFEST.sha256 before anything is written; spec.lock records the tag and each file's hash, and
// web/test/spec-lock.test.js checks the copies against it offline.
//
//   node scripts/spec-sync.mjs v0.1.0                          from GitHub
//   node scripts/spec-sync.mjs v0.1.0 --from ../mccontrol-spec  from a local clone (git show)
//   node scripts/spec-sync.mjs --check                         do the copies equal spec.lock's tag on GitHub?
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = 'sweden-mesh/mccontrol-spec';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LOCK = `${ROOT}spec.lock`;

// Where a spec file lives in this repository.
export function local(path) {
  if (/^data\/[\w.-]+\.json$/.test(path)) return `web/lib/data/${path.slice(5)}`;
  if (/^vectors\/[\w.-]+\.json$/.test(path)) return `web/test/${path.slice(8)}`;
  throw new Error(`${path}: no place for it in this repository`);
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// `{ tag, files: [{ path, local, sha256 }] }` from spec.lock's text.
export function parseLock(text) {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const [, repo, tag] = lines.shift().split(/\s+/);
  if (repo !== REPO) throw new Error(`spec.lock names ${repo}, not ${REPO}`);
  return { tag, files: lines.map((l) => { const [hash, path, at] = l.split(/\s+/); return { path, local: at, sha256: hash }; }) };
}

async function fetchAll(tag, from) {
  const read = from
    ? async (p) => execFileSync('git', ['-C', from, 'show', `${tag}:${p}`], { maxBuffer: 64 << 20 })
    : async (p) => {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/${p}`);
      if (!res.ok) throw new Error(`${p} at ${tag}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };
  const manifest = (await read('MANIFEST.sha256')).toString('utf8').split('\n').filter(Boolean)
    .map((l) => { const [hash, p] = l.split(/\s+/); return { path: p.replace(/^\*/, ''), sha256: hash }; });
  const files = [];
  for (const f of manifest) {
    const body = await read(f.path);
    if (sha256(body) !== f.sha256) throw new Error(`${f.path} at ${tag} does not match MANIFEST.sha256; nothing written`);
    files.push({ ...f, local: local(f.path), body });
  }
  return files;
}

async function main(argv) {
  const check = argv.includes('--check');
  const at = argv.indexOf('--from');
  const from = at >= 0 ? argv[at + 1] : null;
  const tag = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--from')
    || (existsSync(LOCK) && parseLock(readFileSync(LOCK, 'utf8')).tag);
  if (!tag) { console.error('usage: spec-sync.mjs <tag> [--from DIR] | --check'); process.exit(2); }
  const files = await fetchAll(tag, from);
  if (check) {
    const differ = files.filter((f) => !existsSync(`${ROOT}${f.local}`) || sha256(readFileSync(`${ROOT}${f.local}`)) !== f.sha256);
    const lock = parseLock(readFileSync(LOCK, 'utf8'));
    const same = lock.tag === tag && lock.files.length === files.length
      && files.every((f) => lock.files.some((l) => l.path === f.path && l.sha256 === f.sha256 && l.local === f.local));
    if (!same) differ.push({ local: 'spec.lock' });
    console.log(differ.length ? `differs from ${REPO} ${tag}: ${differ.map((f) => f.local).join(', ')}` : `the copies are ${REPO} ${tag}`);
    process.exit(differ.length ? 1 : 0);
  }
  for (const f of files) writeFileSync(`${ROOT}${f.local}`, f.body);
  const lock = ['# mccontrol-spec as copied here by scripts/spec-sync.mjs: never edit by hand',
    `source ${REPO} ${tag}`, ...files.map((f) => `${f.sha256}  ${f.path}  ${f.local}`)].join('\n');
  writeFileSync(LOCK, `${lock}\n`);
  console.log(`${files.length} files from ${REPO} ${tag}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
