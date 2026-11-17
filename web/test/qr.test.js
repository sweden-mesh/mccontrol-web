// The in-house QR code (lib/qr.js) against a decoder written here from the standard's tables, not
// from the encoder: format bits checked against the spec's table, the function patterns, the
// block structure of level M (spec table 9), every block's Reed-Solomon syndromes, and the byte
// segment read back. A changed module must make it fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, qrPath, formatBits } from '../lib/qr.js';
import { utf8, fromUtf8 } from '../lib/bytes.js';

// ISO/IEC 18004 table C.1, level M, masks 0..7 (after the 0x5412 mask), as printed.
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
// Spec table 9, level M: [count, total codewords, data codewords] per block group.
const BLOCKS_M = {
  1: [[1, 26, 16]], 2: [[1, 44, 28]], 3: [[1, 70, 44]], 4: [[2, 50, 32]], 5: [[2, 67, 43]],
  6: [[4, 43, 27]], 7: [[4, 49, 31]], 8: [[2, 60, 38], [2, 61, 39]], 9: [[3, 58, 36], [2, 59, 37]],
  10: [[4, 69, 43], [1, 70, 44]],
};
// Spec annex E: alignment pattern centres.
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
  8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
// Spec annex D: version information for versions 7 to 10.
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

const EXP = []; const LOG = [];
for (let i = 0, x = 1; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
const mul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

const MASK = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];   // i = row, j = column, as the standard writes them

function decode(m) {
  const size = m.length;
  const ver = (size - 17) / 4;
  assert.ok(Number.isInteger(ver) && ver >= 1 && ver <= 10, `size ${size}`);
  const dark = (row, col) => m[row][col];

  // Finder patterns: dark ring, light ring, dark 3x3, and the light separator.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = r0 + r; const col = c0 + c;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        assert.equal(dark(row, col), ring <= 1 || ring === 3, `finder at ${row},${col}`);
      }
    }
  }
  for (let k = 8; k < size - 8; k += 1) {
    assert.equal(dark(6, k), k % 2 === 0, 'timing row');
    assert.equal(dark(k, 6), k % 2 === 0, 'timing column');
  }
  assert.equal(dark(size - 8, 8), true, 'the dark module');

  // Format: both copies, read in the standard's bit order (14 = most significant).
  const first = []; const second = [];
  const firstAt = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  for (const [row, col] of firstAt) first.push(dark(row, col) ? '1' : '0');   // bit 14 first
  for (let k = 0; k < 7; k += 1) second.push(dark(size - 1 - k, 8) ? '1' : '0');
  for (let k = 0; k < 8; k += 1) second.push(dark(8, size - 8 + k) ? '1' : '0');
  const fmt = first.join('');
  assert.equal(second.join(''), fmt, 'the two format copies agree');
  const mask = FORMAT_M.indexOf(fmt);
  assert.ok(mask >= 0, `format ${fmt} is level M`);

  if (ver >= 7) {
    let bits = '';
    for (let k = 17; k >= 0; k -= 1) bits += dark(Math.floor(k / 3), size - 11 + (k % 3)) ? '1' : '0';
    assert.equal(bits, VERSION_INFO[ver].toString(2).padStart(18, '0'), 'version information');
  }

  // Which modules carry data.
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r0, r1, c0, c1) => { for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) reserved[r][c] = true; };
  mark(0, 8, 0, 8); mark(0, 8, size - 8, size - 1); mark(size - 8, size - 1, 0, 8);
  mark(6, 6, 0, size - 1); mark(0, size - 1, 6, 6);
  if (ver >= 7) { mark(0, 5, size - 11, size - 9); mark(size - 11, size - 9, 0, 5); }
  const centres = ALIGN[ver];
  const end = centres.at(-1);
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === end) || (r === end && c === 6)) continue;   // the finders' corners
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          assert.equal(dark(r + dr, c + dc), Math.max(Math.abs(dr), Math.abs(dc)) !== 1, 'alignment');
        }
      }
      mark(r - 2, r + 2, c - 2, c + 2);
    }
  }

  // Read: column pairs from the right, upward first, skipping the timing column.
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let n = 0; n < size; n += 1) {
      const row = upward ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (!reserved[row][c]) bits.push(dark(row, c) !== MASK[mask](row, c) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const groups = BLOCKS_M[ver];
  const total = groups.reduce((n, [count, len]) => n + count * len, 0);
  assert.ok(bits.length >= total * 8 && bits.length < total * 8 + 8, 'remainder bits');
  const words = [];
  for (let k = 0; k < total; k += 1) words.push(bits.slice(k * 8, k * 8 + 8).reduce((a, b) => (a << 1) | b, 0));

  // De-interleave: data codewords column by column, then the error correction the same way.
  const blocks = groups.flatMap(([count, len, data]) => Array.from({ length: count }, () => ({ len, data, words: [] })));
  let at = 0;
  const maxData = Math.max(...blocks.map((b) => b.data));
  for (let k = 0; k < maxData; k += 1) for (const b of blocks) if (k < b.data) b.words.push(words[at++]);
  const eccLen = blocks[0].len - blocks[0].data;
  for (let k = 0; k < eccLen; k += 1) for (const b of blocks) b.words.push(words[at++]);

  // Every block is a codeword of the generator: its syndromes at alpha^0 .. alpha^(ecc-1) are 0.
  for (const b of blocks) {
    for (let s = 0; s < eccLen; s += 1) {
      let v = 0;
      for (const w of b.words) v = mul(v, EXP[s]) ^ w;
      assert.equal(v, 0, 'Reed-Solomon syndrome');
    }
  }

  // The data: one byte segment.
  const data = blocks.flatMap((b) => b.words.slice(0, b.data));
  const stream = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((k) => (w >>> k) & 1));
  const take = (n) => stream.splice(0, n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(take(4), 0b0100, 'byte mode');
  const len = take(ver < 10 ? 8 : 16);
  const out = new Uint8Array(len);
  for (let k = 0; k < len; k += 1) out[k] = take(8);
  return { text: fromUtf8(out), version: ver, mask };
}

const KEY = '736EA54AAE6E1C7652E247B8997DC9B99946F4B41DF64DC0BA6DF148D9029CE4';

test('format bits are the standard table for level M', () => {
  FORMAT_M.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, '0'), bits));
});

test('a public key round-trips through the decoder, in every mask', () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const qr = encodeQr(utf8(KEY), { mask });
    assert.equal(qr.version, 5, '64 bytes at level M need version 5');
    assert.deepEqual(decode(qr.modules), { text: KEY, version: 5, mask });
  }
  const chosen = encodeQr(utf8(KEY));
  assert.equal(decode(chosen.modules).text, KEY);
});

test('lengths across versions 1 to 10, two block groups and version information included', () => {
  for (const len of [0, 1, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213]) {
    const text = 'x'.repeat(len);
    const qr = encodeQr(utf8(text));
    if (qr.version > 10) continue;
    assert.equal(decode(qr.modules).text, text, `length ${len}, version ${qr.version}`);
  }
  assert.equal(encodeQr(utf8('a'.repeat(152))).version, 8);
  assert.equal(encodeQr(utf8('a'.repeat(213))).version, 10);
  assert.equal(encodeQr(utf8('a'.repeat(120))).version, 7);
});

test('one changed data module is caught (the decoder is not a mirror)', () => {
  const qr = encodeQr(utf8(KEY), { mask: 3 });
  const m = qr.modules.map((row) => [...row]);
  m[20][20] = !m[20][20];
  assert.throws(() => decode(m));
});

test('the SVG path has one square per dark module', () => {
  const qr = encodeQr(utf8(KEY));
  const dark = qr.modules.flat().filter(Boolean).length;
  assert.equal(qrPath(qr.modules).match(/M/g).length, dark);
  assert.throws(() => encodeQr(utf8('x'.repeat(3000))), /Too much/);
});
