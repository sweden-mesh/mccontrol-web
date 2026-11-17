// The MeshCore companion protocol, the few frames the mesh road needs: a pure codec, no I/O.
// Read from the companion firmware (examples/companion_radio/MyMesh.cpp, docs/companion_protocol.md)
// and checked against meshcore_py, which mccontrol/mesh.py drives.
//
//   app -> companion   01 03 "      " "mccontrol"       CMD_APP_START (reply 05 SELF_INFO)
//                      1E <key 32>                      CMD_GET_CONTACT_BY_KEY (03 CONTACT | 01 ERR)
//                      04                               CMD_GET_CONTACTS (02 n, 03 ... , 04)
//                      09 <key 32> type flags plen path(64) name(32) last_advert(4) lat(4) lon(4)
//                                                       CMD_ADD_UPDATE_CONTACT (00 OK | 01 ERR)
//                      39 <key 32> <body>               CMD_SEND_ANON_REQ (06 SENT | 01 ERR)
//   companion -> app   06 flood(1) tag(4) timeout_ms(4 LE)          RESP_CODE_SENT
//                      8C 00 tag(4) <data>                          PUSH_CODE_BINARY_RESPONSE
//
// Codes below 0x80 answer the command just sent; 0x80 and up are pushes that may come at any
// time (adverts, log lines, a waiting message) and are never taken as an answer.
//
// Over BLE (the Nordic UART service) one write or notification is one frame. Over USB serial a
// frame is framed: '<' len(2 LE) payload to the companion, '>' len(2 LE) payload from it.
import { concat, fromHex, toHex, utf8 } from '../bytes.js';

export const NUS = Object.freeze({
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',      // app -> companion (write)
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',      // companion -> app (notify)
});

export const CMD = Object.freeze({
  APP_START: 1, GET_CONTACTS: 4, ADD_UPDATE_CONTACT: 9, GET_CONTACT_BY_KEY: 30, SEND_ANON_REQ: 57,
});
export const RESP = Object.freeze({
  OK: 0, ERR: 1, CONTACTS_START: 2, CONTACT: 3, END_OF_CONTACTS: 4, SELF_INFO: 5, SENT: 6, DISABLED: 15,
});
export const PUSH = Object.freeze({ BINARY_RESPONSE: 0x8c });
export const ERR = Object.freeze({ UNSUPPORTED_CMD: 1, NOT_FOUND: 2, TABLE_FULL: 3, BAD_STATE: 4, FILE_IO: 5, ILLEGAL_ARG: 6 });

export const MAX_FRAME = 176;        // MAX_FRAME_SIZE in the companion
export const PATH_SIZE = 64;         // MAX_PATH_SIZE
export const NAME_SIZE = 32;
export const OUT_PATH_UNKNOWN = 0xff; // a contact with no path: requests flood
export const ADV_TYPE_REPEATER = 2;
export const SERIAL_BAUD = 115200;
const TO_COMPANION = 0x3c;           // '<'
const FROM_COMPANION = 0x3e;         // '>'

const key32 = (keyHex) => {
  const key = fromHex(String(keyHex || ''));
  if (key.length !== 32) throw new Error("a companion frame needs the node's whole 32-byte key");
  return key;
};

const u32 = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
};

// UTF-8 of `text` cut to at most `max` bytes on a character boundary.
export function utf8Cut(text, max) {
  let out = utf8(text);
  if (out.length <= max) return out;
  let end = max;
  while (end > 0 && (out[end] & 0xc0) === 0x80) end -= 1;
  out = out.subarray(0, end);
  return out;
}

export const appStart = (name = 'mccontrol') => concat(Uint8Array.of(CMD.APP_START, 3), utf8('      '), utf8(name));
export const getContactByKey = (keyHex) => concat(Uint8Array.of(CMD.GET_CONTACT_BY_KEY), key32(keyHex));
export const getContacts = () => Uint8Array.of(CMD.GET_CONTACTS);

// A repeater with no path, as mccontrol/mesh.py adds it: the first request floods, and the
// node's path return teaches the companion a path for the next one. The name is cut to 31 bytes.
export function addContact(keyHex, name, now = Math.floor(Date.now() / 1000)) {
  const nameBytes = new Uint8Array(NAME_SIZE);
  nameBytes.set(utf8Cut(name || String(keyHex).slice(0, 8), NAME_SIZE - 1));
  return concat(Uint8Array.of(CMD.ADD_UPDATE_CONTACT), key32(keyHex),
    Uint8Array.of(ADV_TYPE_REPEATER, 0, OUT_PATH_UNKNOWN), new Uint8Array(PATH_SIZE), nameBytes,
    u32(now), u32(0), u32(0));
}

export const sendAnonReq = (keyHex, body) => concat(Uint8Array.of(CMD.SEND_ANON_REQ), key32(keyHex), body);

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const cString = (bytes) => {
  const end = bytes.indexOf(0);
  return new TextDecoder('utf-8').decode(end < 0 ? bytes : bytes.subarray(0, end));
};

// One frame from the companion, as { code, push, kind, ... }.
export function parseFrame(frame) {
  const f = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (!f.length) return { code: null, push: false, kind: 'empty' };
  const code = f[0];
  const push = code >= 0x80;
  if (code === RESP.OK) return { code, push, kind: 'ok' };
  if (code === RESP.ERR) return { code, push, kind: 'error', error: f.length > 1 ? f[1] : null };
  if (code === RESP.DISABLED) return { code, push, kind: 'disabled' };
  if (code === RESP.SELF_INFO && f.length >= 36) {
    return { code, push, kind: 'selfInfo', publicKey: toHex(f.subarray(4, 36), true),
      name: f.length > 58 ? cString(f.subarray(58)) : '' };
  }
  if (code === RESP.CONTACTS_START) return { code, push, kind: 'contactsStart', count: f.length >= 5 ? view(f).getUint32(1, true) : null };
  if (code === RESP.END_OF_CONTACTS) return { code, push, kind: 'contactsEnd' };
  if (code === RESP.CONTACT && f.length >= 1 + 32 + 3 + PATH_SIZE + NAME_SIZE) {
    const plen = f[35];
    return {
      code, push, kind: 'contact', publicKey: toHex(f.subarray(1, 33), true), type: f[33], flags: f[34],
      // 0xFF: no path, a request floods; else the low six bits are the hops
      hops: plen === OUT_PATH_UNKNOWN ? -1 : plen & 0x3f,
      name: cString(f.subarray(36 + PATH_SIZE, 36 + PATH_SIZE + NAME_SIZE)),
    };
  }
  if (code === RESP.SENT && f.length >= 10) {
    return { code, push, kind: 'sent', flood: f[1] === 1, tag: toHex(f.subarray(2, 6), true), timeoutMs: view(f).getUint32(6, true) };
  }
  if (code === PUSH.BINARY_RESPONSE && f.length >= 6) {
    return { code, push, kind: 'binaryResponse', tag: toHex(f.subarray(2, 6), true), data: f.slice(6) };
  }
  return { code, push, kind: push ? 'push' : 'other' };
}

// -- USB serial framing -----------------------------------------------------------------------

export function serialFrame(payload) {
  if (payload.length > MAX_FRAME) throw new Error(`a companion frame is at most ${MAX_FRAME} bytes`);
  return concat(Uint8Array.of(TO_COMPANION, payload.length & 0xff, payload.length >> 8), payload);
}

// Bytes from the companion's serial port in, whole frames out. Anything before a '>' (a boot
// message, debug text) is skipped.
export function serialDeframer() {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      buf = concat(buf, chunk);
      const frames = [];
      for (;;) {
        const start = buf.indexOf(FROM_COMPANION);
        if (start < 0) { buf = new Uint8Array(0); break; }
        if (start > 0) buf = buf.slice(start);
        if (buf.length < 3) break;
        const len = buf[1] | (buf[2] << 8);
        if (len === 0 || len > MAX_FRAME) { buf = buf.slice(1); continue; }
        if (buf.length < 3 + len) break;
        frames.push(buf.slice(3, 3 + len));
        buf = buf.slice(3 + len);
      }
      return frames;
    },
  };
}
