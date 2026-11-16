// Bytes, hex and UTF-8: the few conversions every module needs, in one place.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text) => encoder.encode(text);
export const fromUtf8 = (bytes) => decoder.decode(bytes);

export function toHex(bytes, upper = false) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return upper ? out.toUpperCase() : out;
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) {
    throw new TypeError('not hexadecimal');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
