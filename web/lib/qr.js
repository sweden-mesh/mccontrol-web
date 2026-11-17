// A QR code in byte mode at error-correction level M (ISO/IEC 18004), made here so the key screen
// needs no network and no third-party code. Only what the key screen needs: one byte segment,
// level M, versions 1 to 40, the mask chosen by the standard's penalty score (or given).
// The structure follows Project Nayuki's QR Code generator (MIT licence). No DOM.
//
//   const { version, size, modules } = encodeQr(utf8('736EA54A…'));   modules[y][x]: true = dark
//   qrPath(modules)   an SVG path ("M x y h1v1h-1z…") of the dark modules, 1 unit each

// Error-correction codewords per block, and the number of blocks, for level M (index = version).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21,
  23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const LEVEL_M_BITS = 0;        // the two format bits of level M

const bit = (x, i) => ((x >>> i) & 1) !== 0;

// Modules left for data and error correction once the function patterns are drawn.
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

export const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

// The data codewords of one byte segment, terminated and padded to the version's capacity.
function dataFor(bytes, ver) {
  const bits = [];
  const push = (value, len) => { for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

// Split into blocks, add each block's error correction, and interleave.
function withEcc(data, ver) {
  const blocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < short) dat.push(0);
    all.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < all[0].length; i += 1) {
    all.forEach((block, j) => { if (i !== shortLen - eccLen || j >= short) out.push(block[i]); });
  }
  return out;
}

export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The 15 format bits for level M and `mask`, BCH-coded and masked.
export function formatBits(mask) {
  const data = (LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function grid(ver) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };

  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx; const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(ver);
  const last = align.length - 1;
  align.forEach((ay, i) => align.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));
  drawFormat(set, size, 0);      // reserves the areas; drawn for real once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  return { size, modules, fixed, set };
}

function drawFormat(set, size, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true);
}

function placeCodewords({ size, modules, fixed }, codewords) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

function applyMask({ size, modules, fixed }, mask) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (!fixed[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  }
}

// The standard's penalty: runs of five or more, 2x2 blocks, finder-like 1:1:3:1:1 patterns with
// four light modules on a side, and the balance of dark and light.
export function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i += 1) lines.push(modules[i], modules.map((row) => row[i]));
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let k = 1; k <= size; k += 1) {
      if (k < size && line[k] === line[k - 1]) { run += 1; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    for (let k = 0; k + 7 <= size; k += 1) {
      if (!finder.every((v, n) => line[k + n] === v)) continue;
      const light = (from, to) => { for (let n = from; n < to; n += 1) if (n >= 0 && n < size && line[n]) return false; return true; };
      if (light(k - 4, k) || light(k + 7, k + 11)) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

export function encodeQr(bytes, { mask = null } = {}) {
  const data = [...bytes];
  let ver = 1;
  while (ver <= 40 && 4 + (ver < 10 ? 8 : 16) + data.length * 8 > dataCodewords(ver) * 8) ver += 1;
  if (ver > 40) throw new Error('Too much for one QR code.');
  if (mask !== null && !(Number.isInteger(mask) && mask >= 0 && mask < 8)) throw new Error('A mask is 0 to 7.');
  const g = grid(ver);
  placeCodewords(g, withEcc(dataFor(data, ver), ver));
  let chosen = mask;
  if (chosen === null) {
    let best = Infinity;
    for (let m = 0; m < 8; m += 1) {
      applyMask(g, m);
      drawFormat(g.set, g.size, m);
      const p = penalty(g.modules);
      if (p < best) { best = p; chosen = m; }
      applyMask(g, m);
    }
  }
  applyMask(g, chosen);
  drawFormat(g.set, g.size, chosen);
  return Object.freeze({ version: ver, size: g.size, mask: chosen, modules: g.modules });
}

// One SVG path for the dark modules: a 1x1 square each, at (x, y). Draw it in a viewBox of
// size + 8 with the path translated by 4, for the quiet zone the standard asks for.
export function qrPath(modules) {
  const parts = [];
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) parts.push(`M${x} ${y}h1v1h-1z`); }));
  return parts.join('');
}
