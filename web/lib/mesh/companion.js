// The owner's companion radio, over a link that carries whole frames (ble.js, serial.js, or a
// fake in the tests). The same five steps mccontrol/mesh.py's Companion takes through
// meshcore_py: start, find the node as a contact, add it when it is not one, send the request,
// wait for the answer with the request's tag.
//
//   link     { write(bytes): Promise, onFrame(fn), onClose(fn), close(): Promise, kind, label, startWithinMs?,
//              onStatus?(fn) -> unsubscribe: { state: 'reconnecting' | 'open' | 'gone' } (serial.js) }
//   const c = await openCompanion(link)        // app start; c.self = { publicKey, name }
//   await c.contact(keyHex)                    // { name, hops } (hops -1: no path, floods) | null
//   await c.addContact(keyHex, name)
//   await c.contacts()                         // [{ publicKey, type, name, hops }]
//   const sent = await c.send(keyHex, body)    // { tag, flood, timeoutMs }
//   const data = await c.response(sent.tag, ms, signal)   // the bytes after the tag, or null
//
// One command at a time: the next frame under 0x80 is its answer. Pushes (0x80 and up) never
// are; every binary response is kept by its tag, so one that lands before anyone waits is not
// lost. Nothing here transmits on its own: only send() puts a packet on the air.
import {
  ERR, addContact, appStart, getContactByKey, getContacts, parseFrame, sendAnonReq,
} from './frames.js';

export class CompanionError extends Error {
  constructor(message, code = 'companion') {
    super(message);
    this.code = code;          // 'companion' | 'timeout' | 'closed' | 'full' | 'refused' | 'otherFirmware'
  }
}

export const COMMAND_TIMEOUT_MS = 5000;
export const OTHER_FIRMWARE = "The companion restarted but doesn't answer over USB. It probably runs the Bluetooth (or Wi-Fi) companion firmware, which only talks over that link: connect by Bluetooth, or flash the USB companion firmware.";
export const START_FIRST_MS = 1500;    // the first app start's wait before it is asked again
export const START_EVERY_MS = 500;     // then again this often, until the link's startWithinMs

export async function openCompanion(link, {
  appName = 'mccontrol', timeoutMs = COMMAND_TIMEOUT_MS,
  startWithinMs = link.startWithinMs ?? timeoutMs, startFirstMs = START_FIRST_MS, startEveryMs = START_EVERY_MS,
} = {}) {
  let waiting = null;          // { resolve, reject, timer } for the command in flight
  let queue = Promise.resolve();
  let closed = false;
  const answers = new Map();   // tag -> data
  const watchers = new Set();

  link.onFrame((bytes) => {
    const f = parseFrame(bytes);
    if (f.kind === 'binaryResponse') {
      answers.set(f.tag, f.data);
      for (const w of watchers) w();
      return;
    }
    if (f.push || !waiting) return;
    const w = waiting;
    waiting = null;
    clearTimeout(w.timer);
    w.resolve(f);
  });
  link.onClose(() => {
    closed = true;
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(new CompanionError('the companion disconnected', 'closed')); waiting = null; }
    for (const w of watchers) w();
  });

  // Send one frame and resolve with the companion's answer to it.
  function ask(frame, ms = timeoutMs) {
    const run = () => new Promise((resolve, reject) => {
      if (closed) { reject(new CompanionError('the companion is not connected', 'closed')); return; }
      const timer = setTimeout(() => {
        waiting = null;
        reject(new CompanionError(`the companion did not answer in ${Math.round(ms / 1000)} s`, 'timeout'));
      }, ms);
      waiting = { resolve, reject, timer };
      Promise.resolve(link.write(frame)).catch((e) => {
        clearTimeout(timer);
        waiting = null;
        reject(new CompanionError(`cannot write to the companion: ${e?.message || e}`));
      });
    });
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  // Every frame of a contact list, until its end.
  function askList(frame, ms = timeoutMs) {
    const run = () => new Promise((resolve, reject) => {
      const items = [];
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { waiting = null; reject(new CompanionError('the companion stopped listing its contacts', 'timeout')); }, ms);
      };
      const take = (f) => {
        if (f.kind === 'error') { clearTimeout(timer); reject(new CompanionError(`the companion refused the contact list (error ${f.error})`, 'refused')); return; }
        if (f.kind === 'contactsEnd') { clearTimeout(timer); resolve(items); return; }
        if (f.kind === 'contact') items.push(f);
        arm();
        waiting = { resolve: take, reject, timer };
      };
      arm();
      waiting = { resolve: take, reject, timer };
      Promise.resolve(link.write(frame)).catch((e) => { clearTimeout(timer); waiting = null; reject(new CompanionError(e?.message || String(e))); });
    });
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  const hello = await start();
  const self = Object.freeze({ publicKey: hello.publicKey, name: hello.name });

  // App start. A board on native USB may restart when its port opens (Chrome toggles DTR and RTS
  // inside open(), before serial.js can drop them, W-21) and spends a second or two booting, so
  // the first ask can go unheard: ask again every `startEveryMs` after `startFirstMs`, until
  // `startWithinMs`, taking only SELF_INFO as the answer (a boot log's stray frame is not one).
  // On an ESP32-S3's native USB that restart drops the port: while the link reopens it (W-25b) the
  // asking pauses, and once it is open again it starts over with a fresh `startWithinMs`.
  function start() {
    const frame = appStart(appName);
    return new Promise((resolve, reject) => {
      let other = null;
      let writeError = null;
      let retry = null;
      let sent = 0;
      let deadline = null;
      let unwatch = () => {};
      const stop = () => { clearTimeout(retry); clearTimeout(deadline); unwatch(); waiting = null; };
      const fail = (e) => { stop(); reject(e); };
      const take = (f) => {
        if (f.kind === 'selfInfo') { stop(); resolve(f); return; }
        other = f;
        waiting = { resolve: take, reject: fail, timer: null };
      };
      const send = () => {
        if (closed) { fail(new CompanionError('the companion is not connected', 'closed')); return; }
        Promise.resolve(link.write(frame)).then(() => { writeError = null; }, (e) => { writeError = e; });
        retry = setTimeout(send, sent++ ? startEveryMs : startFirstMs);
      };
      const late = () => {
        stop();
        if (other) reject(new CompanionError('the device did not answer as a MeshCore companion'));
        else if (writeError) reject(new CompanionError(`cannot write to the companion: ${writeError?.message || writeError}`));
        // A board that printed its boot log but never framed an answer runs a companion build for
        // another link: a build has one interface (examples/companion_radio/main.cpp: BLE_PIN_CODE
        // gives SerialBLEInterface, else ArduinoSerialInterface), so a Bluetooth or Wi-Fi companion
        // never answers over USB (operator's V4 capture, 2026-11-17).
        else if (link.kind === 'usb' && link.heardBytes > 0) reject(new CompanionError(OTHER_FIRMWARE, 'otherFirmware'));
        else if (link.kind === 'usb') reject(new CompanionError("the companion didn't answer after it restarted: is it running companion firmware for USB?", 'timeout'));
        else reject(new CompanionError(`the companion did not answer in ${Math.round(startWithinMs / 1000)} s`, 'timeout'));
      };
      unwatch = link.onStatus?.((st) => {
        if (st.state === 'reconnecting') { clearTimeout(retry); clearTimeout(deadline); return; }
        if (st.state === 'open') { other = null; writeError = null; sent = 0; deadline = setTimeout(late, startWithinMs); send(); return; }
        if (st.state === 'gone') fail(new CompanionError('the companion restarted and did not come back over USB', 'closed'));
      }) || (() => {});
      deadline = setTimeout(late, startWithinMs);
      waiting = { resolve: take, reject: fail, timer: null };
      send();
    });
  }

  const asContact = (f) => ({ name: f.name, hops: f.hops });

  return Object.freeze({
    self,
    kind: link.kind,
    label: link.label || self.name,
    get closed() { return closed; },

    async contact(keyHex) {
      const f = await ask(getContactByKey(keyHex));
      if (f.kind === 'contact') return asContact(f);
      if (f.kind === 'error' && f.error === ERR.NOT_FOUND) return null;
      if (f.kind === 'error' && f.error === ERR.UNSUPPORTED_CMD) {
        // an older companion: read the whole list
        const want = String(keyHex).toUpperCase();
        const hit = (await askList(getContacts())).find((c) => c.publicKey === want);
        return hit ? asContact(hit) : null;
      }
      throw new CompanionError(`the companion could not look the node up (error ${f.error ?? f.code})`, 'refused');
    },

    // Every contact the companion holds: [{ publicKey, type, name, hops }] (type 2: a repeater).
    // Reads the radio's own list; nothing is transmitted (W-20a: mesh-only nodes).
    async contacts() {
      return (await askList(getContacts())).map((f) => ({ publicKey: f.publicKey, type: f.type, name: f.name, hops: f.hops }));
    },

    async addContact(keyHex, name) {
      const f = await ask(addContact(keyHex, name));
      if (f.kind === 'ok') return true;
      if (f.kind === 'error' && f.error === ERR.TABLE_FULL) return false;
      throw new CompanionError(`the companion would not take the node as a contact (error ${f.error ?? f.code})`, 'refused');
    },

    async send(keyHex, body) {
      const f = await ask(sendAnonReq(keyHex, body));
      if (f.kind === 'sent') return { tag: f.tag, flood: f.flood, timeoutMs: f.timeoutMs };
      if (f.kind === 'error' && f.error === ERR.TABLE_FULL) {
        throw new CompanionError('the companion could not send: its queue or contact list is full', 'full');
      }
      throw new CompanionError(`the companion refused the request (error ${f.error ?? f.code})`, 'refused');
    },

    // The bytes after the tag of the answer with `tag`, or null after `ms` (or an abort).
    response(tag, ms, signal = null) {
      return new Promise((resolve) => {
        const done = (value) => { watchers.delete(check); clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(value); };
        const check = () => {
          if (answers.has(tag)) { const data = answers.get(tag); answers.delete(tag); done(data); } else if (closed) done(null);
        };
        const stop = () => done(answers.get(tag) ?? null);
        const timer = setTimeout(stop, Math.max(0, ms));
        watchers.add(check);
        signal?.addEventListener('abort', stop, { once: true });
        check();
      });
    },

    close: () => link.close(),
  });
}
