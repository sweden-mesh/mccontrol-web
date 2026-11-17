// Setup's "Put the key on a node" tab (W-13, W-20h): give a repeater this key over its USB console. With Web Serial (Chromium,
// and Firefox from 151) the page connects at 115200 baud, shows what the console says, and offers
// one button per console line: set the key, check it, turn the command plane on, and reboot only
// once the node has asked for it. Nothing is written to the port without a button press. The
// same lines are shown to type by hand, each with its own Copy button, for an iPhone, an iPad or any browser without Web Serial.
import { h } from '../dom.js';
import { openQuiet } from '../../lib/mesh/serial.js';
import { copyButton, groupedHex, useStyles } from './key-kit.js';
import { keyStatus, onKeyStatus } from './key-session.js';

export const route = 'setup';
export const title = 'nav.setup';

export const BAUD = 115200;

// The lines, in order. The firmware reads a line up to '\r'.
export const setupLines = (pub) => [`set mqtt.cmd.pubkey ${String(pub).toUpperCase()}`, 'set mqtt.cmd on'];
export const CHECK_LINE = 'get mqtt.cmd.pubkey';
export const REBOOT_LINE = 'reboot';
export const consoleBytes = (line) => new TextEncoder().encode(`${line}\r`);

// The node asked for a reboot ("OK - reboot to apply").
export const asksReboot = (text) => /reboot to apply/i.test(String(text || ''));
// The console shows this public key (the answer to the check line).
export const showsKey = (text, pub) => String(text || '').toUpperCase().includes(String(pub || '').toUpperCase());
export const serialAvailable = (nav = globalThis.navigator) => Boolean(nav && 'serial' in nav);

const MAX_LOG = 8000;

// What the console said after the check line was sent: the verdict reads only this, never the
// page's own echo of `set mqtt.cmd.pubkey <key>` above it, which holds the key too (W-12).
export function consoleLog(max = MAX_LOG) {
  let text = '';
  let since = null;
  return {
    append(chunk) {
      text = (text + chunk).slice(-max);
      if (since !== null) since = (since + chunk).slice(-max);
    },
    mark() { since = ''; },
    text: () => text,
    sinceMark: () => since ?? '',
  };
}

function serialPanel(ctx, pub) {
  const { t } = ctx;
  const log = h('pre', { class: 'console', role: 'log', 'aria-live': 'off', tabindex: '0', 'aria-label': t('setup.consoleLabel') });
  const state = h('p', { role: 'status', class: 'serial-state' }, t('setup.notConnected'));
  const connect = h('button', { type: 'button', class: 'button' }, t('setup.connect'));
  const disconnect = h('button', { type: 'button', class: 'tool', hidden: true }, t('setup.disconnect'));
  const [setKey, cmdOn] = setupLines(pub);
  const steps = [
    { id: 'key', line: setKey, label: t('setup.btnKey') },
    { id: 'check', line: CHECK_LINE, label: t('setup.btnCheck') },
    { id: 'on', line: cmdOn, label: t('setup.btnOn') },
    { id: 'reboot', line: REBOOT_LINE, label: t('setup.btnReboot') },
  ];
  const buttons = Object.fromEntries(steps.map((s) => [s.id, h('button', { type: 'button', class: 'tool', disabled: true }, s.label)]));
  buttons.reboot.hidden = true;
  const verdict = h('p', { role: 'status' });
  let port = null; let reader = null;
  const said = consoleLog();

  const append = (chunk) => {
    said.append(chunk);
    log.textContent = said.text();
    log.scrollTop = log.scrollHeight;
    if (asksReboot(said.text())) buttons.reboot.hidden = false;
  };

  const connected = (on) => {
    for (const b of Object.values(buttons)) b.disabled = !on;
    connect.hidden = on;
    disconnect.hidden = !on;
    state.textContent = t(on ? 'setup.connected' : 'setup.notConnected');
  };

  async function close() {
    try { await reader?.cancel(); } catch { /* already gone */ }
    try { await port?.close(); } catch { /* already closed */ }
    reader = null; port = null;
    connected(false);
  }

  async function readLoop() {
    const decoder = new TextDecoder();
    while (port?.readable) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          append(decoder.decode(value, { stream: true }).replace(/\r(?!\n)/g, '\n'));
        }
      } catch {
        break;                   // unplugged, or closed by us
      } finally {
        reader.releaseLock();
      }
    }
    if (!ctx.signal.aborted) close();
  }

  connect.addEventListener('click', async () => {
    try {
      port = await navigator.serial.requestPort();
      await openQuiet(port, BAUD);
    } catch (err) {
      port = null;
      state.textContent = err?.name === 'NotFoundError' ? t('setup.noPortChosen') : t('setup.openFailed', { reason: err?.message || err });
      return;
    }
    connected(true);
    readLoop();
  });
  disconnect.addEventListener('click', close);
  ctx.signal.addEventListener('abort', close, { once: true });

  for (const s of steps) {
    buttons[s.id].addEventListener('click', async () => {
      if (!port?.writable) return;
      const writer = port.writable.getWriter();
      try {
        append(`\n> ${s.line}\n`);
        if (s.id === 'check') said.mark();
        await writer.write(consoleBytes(s.line));
      } finally {
        writer.releaseLock();
      }
      if (s.id === 'check') {
        setTimeout(() => {
          verdict.textContent = t(showsKey(said.sinceMark(), pub) ? 'setup.keyMatches' : 'setup.keyNotSeen');
        }, 1500);
      }
    });
  }

  return h('section', { class: 'key-block', 'aria-labelledby': 'usb-title' },
    h('h3', { id: 'usb-title' }, t('setup.usbTitle')),
    h('ol', { class: 'steps' }, h('li', {}, t('setup.step1')), h('li', {}, t('setup.step2')), h('li', {}, t('setup.step3'))),
    h('p', { class: 'muted' }, t('setup.firefox')),
    h('div', { class: 'row wrap' }, connect, disconnect), state,
    h('div', { class: 'row wrap serial-buttons' }, steps.map((s) => buttons[s.id])),
    h('p', { class: 'hint-line' }, t('setup.rebootWhen')),
    verdict, log);
}

// One line to type, with its own Copy button (W-20h).
function lineRow(t, line, id) {
  const code = h('code', { id, translate: 'no' }, line);
  return h('li', { class: 'copy-line' }, code, copyButton(t, line, t('keyscreen.copy'), { target: code, describedBy: id }));
}

export function render(ctx) {
  useStyles();
  const { t } = ctx;
  const body = h('div', {});
  const section = h('section', { 'aria-labelledby': 'setup-node-title', class: 'scr key-screen' },
    h('h2', { id: 'setup-node-title' }, t('setup.tab.node')), h('p', {}, t('setup.intro')), body);
  const draw = (s) => {
    if (!s.exists) {
      body.replaceChildren(h('p', {}, t('setup.noKey')), h('p', {}, h('a', { class: 'button', href: '#/unlock/to/setup' }, t('keyscreen.toStart'))));
      return;
    }
    const pub = s.publicKeyHex;
    const lines = setupLines(pub);
    const keyCode = h('code', { id: 'setup-pub', translate: 'no' }, groupedHex(pub));
    body.replaceChildren(
      h('section', { class: 'key-block', 'aria-labelledby': 'put-title' },
        h('h3', { id: 'put-title' }, t('setup.keyTitle')),
        h('p', { class: 'pubkey copy-line' }, keyCode,
          copyButton(t, String(pub).toUpperCase(), t('keyscreen.copy'), { target: keyCode, describedBy: 'put-title' }))),
      serialAvailable() ? serialPanel(ctx, pub) : h('section', { class: 'key-block', 'aria-labelledby': 'usb-title' },
        h('h3', { id: 'usb-title' }, t('setup.usbTitle')), h('p', {}, t('setup.noSerial'))),
      h('section', { class: 'key-block', 'aria-labelledby': 'hand-title' },
        h('h3', { id: 'hand-title' }, t('setup.handTitle')),
        h('p', {}, t('setup.handBody', { baud: BAUD })),
        h('ol', { class: 'lines', translate: 'no' }, lines.map((line, i) => lineRow(t, line, `setup-line-${i + 1}`))),
        h('p', { class: 'muted' }, t('setup.handReply')),
        h('p', { class: 'muted' }, t('setup.ownRegion'), ' ', h('a', { href: '#help/ownregion' }, t('setup.ownRegionLink')))),
      h('section', { class: 'key-block', 'aria-labelledby': 'then-title' },
        h('h3', { id: 'then-title' }, t('setup.thenTitle')),
        h('p', {}, t('setup.thenBody'))));
  };
  draw(keyStatus());
  // A lock does not change what this screen shows; a new or replaced key does.
  let shown = keyStatus().publicKeyHex;
  const stop = onKeyStatus((s) => {
    if (s.publicKeyHex !== shown) {
      shown = s.publicKeyHex;
      draw(s);
    }
  });
  ctx.signal.addEventListener('abort', stop, { once: true });
  return section;
}
