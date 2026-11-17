// A fake companion radio at the frame level, for the mesh tests: it answers the frames the
// firmware answers (examples/companion_radio/MyMesh.cpp), with pushes mixed in, and plays the
// node behind it -- checking the request's signature against the command key, as the node does.
// Nothing here opens a radio or transmits.
import { ed25519 } from '../vendor/noble-curves/ed25519.js';
import { concat, fromHex, toHex, utf8 } from '../lib/bytes.js';
import { CMD, ERR, PUSH, RESP } from '../lib/mesh/frames.js';
import { meshResponse } from '../lib/protocol/mesh.js';
import { signedMessage, signedPart } from '../lib/protocol/envelope.js';

const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const later = (fn) => setTimeout(fn, 0);

// options:
//   ownerKey       the command key the node holds (64 hex); a request it does not verify is silence
//   region         the region the node rebuilds its topic with ('mesh' for a mesh-only node)
//   contacts       { KEYHEX: hops } already on the companion (hops -1: no path)
//   answer(cmd, counter) -> { code, reply } | null      the node's answer; null: silence
//   oldCompanion   CMD_GET_CONTACT_BY_KEY unsupported (err 1): the list is read instead
//   full           the contact table is full (add refused, err 3)
//   floodSent      the companion reports the request went as a flood
//   clock          the node's clock (unset by default)
export function fakeCompanion({
  ownerKey, region = 'JKG', contacts = {}, answer = () => ({ code: 0, reply: 'OK' }), oldCompanion = false,
  full = false, floodSent = false, clock = 1715770351, selfName = 'LouHome',
} = {}) {
  const written = [];
  const book = new Map(Object.entries(contacts).map(([k, hops]) => [k.toUpperCase(), hops]));
  let frameFn = () => {};
  let closeFn = () => {};
  let open = true;
  let tagSeq = 0x6553f100;
  const emit = (bytes) => later(() => { if (open) frameFn(bytes); });

  const contactFrame = (key, hops, code = RESP.CONTACT) => {
    const name = new Uint8Array(32); name.set(utf8('node').subarray(0, 31));
    return concat(Uint8Array.of(code), fromHex(key), Uint8Array.of(2, 0, hops < 0 ? 0xff : hops), new Uint8Array(64), name,
      u32(0), u32(0), u32(0), u32(0));
  };

  function node(key, body) {
    if (body[0] !== 0xc1 || body.length < 74) return null;
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const counter = v.getUint32(1, true);
    const expiry = v.getUint32(5, true);
    const sig = body.subarray(9, 73);
    const command = new TextDecoder().decode(body.subarray(73));
    const topic = `meshcore/${region}/${key}/cmd`;
    let ok = false;
    try { ok = ed25519.verify(sig, signedMessage(topic, signedPart(counter, expiry, command)), fromHex(ownerKey)); } catch { ok = false; }
    if (!ok) return null;                         // sig-invalid: silent
    const a = answer(command, counter);
    return a ? meshResponse(clock, counter, a.code, a.reply || '') : null;
  }

  const link = {
    kind: 'fake', label: 'fake companion', written,
    onFrame(fn) { frameFn = fn; },
    onClose(fn) { closeFn = fn; },
    async close() { open = false; closeFn(); },
    drop() { open = false; closeFn(); },
    async write(frame) {
      written.push(frame);
      const code = frame[0];
      emit(Uint8Array.of(0x88, 1, 2, 3));                       // a log push between frames, never an answer
      if (code === CMD.APP_START) {
        const self = concat(Uint8Array.of(RESP.SELF_INFO, 1, 22, 22), new Uint8Array(32).fill(0xab), new Uint8Array(22), utf8(selfName));
        emit(self);
      } else if (code === CMD.GET_CONTACT_BY_KEY) {
        if (oldCompanion) { emit(Uint8Array.of(RESP.ERR, ERR.UNSUPPORTED_CMD)); return; }
        const key = toHex(frame.subarray(1, 33), true);
        emit(book.has(key) ? contactFrame(key, book.get(key)) : Uint8Array.of(RESP.ERR, ERR.NOT_FOUND));
      } else if (code === CMD.GET_CONTACTS) {
        emit(concat(Uint8Array.of(RESP.CONTACTS_START), u32(book.size)));
        for (const [k, hops] of book) emit(contactFrame(k, hops));
        emit(Uint8Array.of(RESP.END_OF_CONTACTS));
      } else if (code === CMD.ADD_UPDATE_CONTACT) {
        if (full) { emit(Uint8Array.of(RESP.ERR, ERR.TABLE_FULL)); return; }
        book.set(toHex(frame.subarray(1, 33), true), frame[35] === 0xff ? -1 : frame[35] & 0x3f);
        emit(Uint8Array.of(RESP.OK));
      } else if (code === CMD.SEND_ANON_REQ) {
        const key = toHex(frame.subarray(1, 33), true);
        const tag = u32((tagSeq += 1));
        emit(concat(Uint8Array.of(RESP.SENT, floodSent || book.get(key) < 0 ? 1 : 0), tag, u32(1500)));
        emit(Uint8Array.of(0x80, ...new Uint8Array(32)));     // an advert push
        const data = node(key, frame.subarray(33));
        if (data) emit(concat(Uint8Array.of(PUSH.BINARY_RESPONSE, 0), tag, data));
      } else {
        emit(Uint8Array.of(RESP.ERR, ERR.UNSUPPORTED_CMD));
      }
    },
  };
  return { link, book, written };
}
