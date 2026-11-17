// Small text rules Python gives for free and JavaScript does not: whitespace collapsing as
// str.split() does it, str.isprintable(), int() of a decimal field, base64url without padding.

// str.split() with no argument: the words.
export const words = (text) => (text || '').split(/\s+/).filter(Boolean);

// " ".join(text.split()): runs of whitespace made one space, none at either end.
export const squash = (text) => words(text).join(' ');

// str.isprintable(): no control, format, surrogate, private-use, unassigned or separator
// character, except the plain space.
export const isPrintable = (text) => !/[\p{C}\p{Z}]/u.test(text.replaceAll(' ', ''));

// int(field) for the decimal fields of a result line: optional whitespace and sign, digits
// with single underscores between them. NaN where Python's int() would raise. A value past
// 2^53 cannot be held exactly and is NaN too; no counter or code is that large.
export function pyInt(field) {
  const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(field);
  if (!m) return NaN;
  const n = Number(m[2].replaceAll('_', ''));
  if (!Number.isSafeInteger(n)) return NaN;
  return m[1] === '-' ? -n : n;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += B64[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

// envelope._unb64: the url-safe alphabet only, unpadded, never a length of 4n+1. Trailing
// bits are ignored, as Python's decoder ignores them.
export function unb64url(text) {
  if (!text || text.length % 4 === 1 || [...text].some((c) => !B64.includes(c))) {
    throw new Error('not base64url');
  }
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of text) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

// len() of a Python str: code points, not UTF-16 units.
export const codePoints = (text) => [...text].length;
