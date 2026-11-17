// The broker login a node presents, made with the owner's key (a port of mccontrol/token.py):
//
//   username   v1_<64 upper-case hex of the public key>
//   password   <b64url(header)>.<b64url(payload)>.<128 upper-case hex Ed25519 signature>
//   header     {"alg":"Ed25519","typ":"JWT"}
//   payload    {"publicKey":"<64 hex>","aud":"<broker host>","iat":<s>,"exp":<s>,"client":"mccontrol"}
//
// The third part is hex, not base64url: that is what the firmware writes.
import { toHex, utf8 } from '../bytes.js';
import { TOKEN } from './constants.js';
import { b64url } from './text.js';

const nowSecs = () => Math.floor(Date.now() / 1000);

// json.dumps(..., separators=(",", ":")): compact, and non-ASCII escaped as \uXXXX.
const compact = (obj) => JSON.stringify(obj)
  .replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export const username = (handle) => TOKEN.username_prefix + handle.publicKeyHex;

// The token for `audience` (the broker's host name), as the password string.
export function makeToken(handle, audience, { now = nowSecs(), lifetime = TOKEN.lifetime_secs } = {}) {
  const header = b64url(utf8(compact({ alg: 'Ed25519', typ: 'JWT' })));
  const payload = b64url(utf8(compact({
    publicKey: handle.publicKeyHex, aud: audience, iat: now, exp: now + lifetime, client: TOKEN.client,
  })));
  const signature = toHex(handle.sign(utf8(`${header}.${payload}`)), true);
  return `${header}.${payload}.${signature}`;
}
