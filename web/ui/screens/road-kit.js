// The mesh road on the screens (W-16): the road choice (Auto / MQTT / Mesh), the companion
// control (connect by Bluetooth, USB or the network through mccontrol-bridge, its state, what this
// browser cannot do), and the words
// for which road a result took. Used by the send panel (node and send screens) and settings.
import { h } from '../dom.js';
import { field, put, useStyles } from './node-kit.js';
import { connect, disconnect, onCompanion, state, support } from '../companion-session.js';
import { bridgeAddress, companionKind, meshAfterMins } from './settings-store.js';

let count = 0;

// A fieldset of three radios. `meshOnly`: MQTT cannot reach the node, so it is not offered.
export function roadChoice(ctx, { initial = 'mqtt', meshOnly = false, onChange }) {
  const name = `road-${count += 1}`;
  const hintId = `${name}-hint`;
  const value = meshOnly && initial === 'mqtt' ? 'auto' : initial;
  const radios = ['auto', 'mqtt', 'mesh'].map((r) => {
    const input = h('input', { type: 'radio', name, value: r, checked: r === value, disabled: meshOnly && r === 'mqtt' });
    input.addEventListener('change', () => { if (input.checked) onChange(r); }, { signal: ctx.signal });
    return h('label', {}, input, ' ', ctx.t(`road.${r}`));
  });
  const el = h('fieldset', { class: 'choice road-choice', 'aria-describedby': hintId },
    h('legend', {}, ctx.t('road.legend')), radios,
    h('p', { class: 'hint-line', id: hintId }, ctx.t('road.hint', { mins: meshAfterMins() }), ' ',
      h('a', { href: '#/help/mesh' }, ctx.t('road.help'))));
  return { el, value };
}

// "Connected to LouHome by Bluetooth" with the buttons to connect or disconnect, and a sentence
// when this browser cannot reach a companion at all.
export function companionControl(ctx) {
  useStyles();
  const can = support();
  const status = h('p', { role: 'status', class: 'companion-state' });
  const bt = h('button', { type: 'button', class: 'tool' }, ctx.t('companion.bluetooth'));
  const usb = h('button', { type: 'button', class: 'tool' }, ctx.t('companion.usb'));
  const off = h('button', { type: 'button', class: 'tool' }, ctx.t('companion.disconnect'));
  bt.addEventListener('click', () => connect('bluetooth'), { signal: ctx.signal });
  usb.addEventListener('click', () => connect('usb'), { signal: ctx.signal });
  off.addEventListener('click', () => disconnect(), { signal: ctx.signal });
  const note = h('p', { class: 'hint-line' });
  const buttons = h('div', { class: 'row wrap' });
  const preferred = companionKind();

  function draw(s) {
    const kind = s.kind ? ctx.t(`companion.kind.${s.kind}`) : '';
    status.textContent = s.status === 'connected' ? ctx.t('companion.connected', { name: s.name || kind, kind })
      : s.status === 'connecting' ? ctx.t(s.phase === 'reconnecting' ? 'companion.reconnecting' : 'companion.connecting')
        : s.status === 'error' ? companionError(ctx, s) : ctx.t('companion.none');
    const list = s.status === 'connected' ? [off]
      : [can.bluetooth ? bt : null, can.usb ? usb : null].filter(Boolean);
    if (preferred === 'usb') list.reverse();
    for (const b of [bt, usb, off]) b.disabled = s.status === 'connecting';
    put(buttons, list);
    note.textContent = can.ios ? ctx.t('companion.ios')
      : !can.bluetooth && !can.usb ? ctx.t('companion.unsupported')
        : !can.bluetooth ? ctx.t('companion.usbOnly') : '';
    note.hidden = !note.textContent;
  }
  draw(state());
  const stop = onCompanion(draw);
  ctx.signal.addEventListener('abort', stop, { once: true });
  return h('div', { class: 'companion' }, status, buttons, note, networkForm(ctx));
}

// "Network (bridge)" (W-31d): a companion reached through mccontrol-bridge on the owner's network.
// The address is remembered on this device, a token never is. Connect runs in the click, so
// Chrome can show its one-time "local network" prompt.
export function networkForm(ctx) {
  const id = `net-${count += 1}`;
  const address = h('input', { type: 'text', id: `${id}-addr`, inputmode: 'url', autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'off', placeholder: 'ws://192.168.1.20:8765', value: bridgeAddress(), class: 'mono' });
  const token = h('input', { type: 'password', id: `${id}-token`, autocomplete: 'off', spellcheck: 'false' });
  const tokenField = field(ctx.t('companion.net.tokenLabel'), token, ctx.t('companion.net.tokenHint'));
  const go = h('button', { type: 'submit', class: 'tool' }, ctx.t('companion.net.connect'));
  const showToken = () => { tokenField.hidden = !/^\s*wss:/i.test(address.value); };
  address.addEventListener('input', showToken, { signal: ctx.signal });
  showToken();
  const form = h('form', { class: 'stack companion-net', novalidate: true },
    h('h4', {}, ctx.t('companion.kind.network')),
    field(ctx.t('companion.net.address'), address, ctx.t('companion.net.addressHint')),
    tokenField, h('div', { class: 'row' }, go),
    h('p', { class: 'hint-line' }, ctx.t('companion.net.prompt')),
    h('p', { class: 'hint-line' }, ctx.t('companion.net.other'), ' ', h('a', { href: '#help/mesh' }, ctx.t('road.help'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    connect('network', { address: address.value, token: token.value });
    token.value = '';
  }, { signal: ctx.signal });
  return form;
}

// The companion's error: in the page's language when it has a known reason (errorKey).
export const companionError = (ctx, s) => (s.errorKey ? ctx.t(s.errorKey) : ctx.t('companion.error', { error: s.error }));

// Why this browser cannot reach a companion one way, or '' when it can (W-23a).
function missingWhy(ctx, can, kind) {
  if (can[kind]) return '';
  if (kind === 'network') return ctx.t('companion.net.none');
  if (can.ios) return ctx.t('companion.ios');
  if (can.secure === false) return ctx.t('companion.insecure');
  return ctx.t(kind === 'bluetooth' ? 'companion.noBluetooth' : 'companion.noUsb');
}

// The small chooser (W-23a): "Bluetooth" and "USB", each with why it is missing in this browser;
// once connected, the radio and Disconnect.
// A button's click is the gesture the browser's own device list needs, so connect() runs in it.
export function companionChooser(ctx) {
  useStyles();
  const can = support();
  const id = `cc-${count += 1}`;
  const order = companionKind() === 'usb' ? ['usb', 'bluetooth', 'network'] : companionKind() === 'network'
    ? ['network', 'bluetooth', 'usb'] : ['bluetooth', 'usb', 'network'];
  const cancel = h('button', { type: 'button', class: 'tool' }, ctx.t('node.cancel'));
  const s = state();
  let body;
  if (s.status === 'connected') {
    const kindWord = s.kind ? ctx.t(`companion.kind.${s.kind}`) : '';
    const off = h('button', { type: 'button', class: 'button' }, ctx.t('companion.disconnect'));
    off.addEventListener('click', () => { dialog.close(); disconnect(); });
    body = [h('p', {}, ctx.t('companion.connected', { name: s.name || kindWord, kind: kindWord })), h('p', {}, off)];
  } else {
    body = [s.status === 'error' ? h('p', { class: 'hint-line' }, companionError(ctx, s)) : null,
      h('ul', { class: 'chooser-list' }, order.map((kind) => {
        const why = missingWhy(ctx, can, kind);
        const b = h('button', { type: 'button', class: 'button', disabled: Boolean(why), 'aria-describedby': why ? `${id}-${kind}` : null },
          ctx.t(`companion.kind.${kind}`));
        // the network needs an address: the last one, else Setup's form (and a token over wss://)
        b.addEventListener('click', () => {
          dialog.close();
          if (kind !== 'network') connect(kind);
          else if (bridgeAddress() && !/^wss:/i.test(bridgeAddress())) connect('network', { address: bridgeAddress() });
          else if (ctx.navigate) ctx.navigate('#setup/connections'); else globalThis.location.hash = '#setup/connections';
        });
        return h('li', {}, b, why ? h('p', { class: 'hint-line', id: `${id}-${kind}` }, why) : null);
      }))];
  }
  const dialog = h('dialog', { class: 'dlg companion-chooser', 'aria-labelledby': id, closedby: 'any' },
    h('h2', { id }, ctx.t('companion.chooseTitle')), ...body,
    h('div', { class: 'row-end' }, cancel));
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  (dialog.querySelector('.chooser-list button:not([disabled]), .dlg > p > .button') || cancel).focus();
  return dialog;
}

// One line for the NODE tile's command area (W-23a, W-23i): "Companion: not connected" as a
// button that opens the chooser (the radio's name once connected; the error in its title).
export function companionBrief(ctx) {
  const button = h('button', { type: 'button', class: 'link-button companion-brief' });
  button.addEventListener('click', () => companionChooser(ctx), { signal: ctx.signal });
  function draw(s) {
    const kind = s.kind ? ctx.t(`companion.kind.${s.kind}`) : '';
    const word = s.status === 'connected' ? ctx.t('companion.briefConnected', { name: s.name || kind, kind })
      : s.status === 'connecting' ? ctx.t(s.phase === 'reconnecting' ? 'companion.reconnecting' : 'companion.connecting')
        : s.status === 'error' ? ctx.t('companion.briefError') : ctx.t('companion.briefNone');
    button.textContent = word;
    button.disabled = s.status === 'connecting';
    button.title = s.status === 'error' ? companionError(ctx, s) : '';
  }
  draw(state());
  const stop = onCompanion(draw);
  ctx.signal.addEventListener('abort', stop, { once: true });
  return button;
}

// The sentence for how an outcome travelled, or null for a plain MQTT send.
export function roadLine(ctx, o) {
  const why = o.why ? ctx.t(`road.why.${o.why.code}`, o.why.vars) : '';
  if (o.road === 'mesh') {
    const path = !o.info ? '' : o.info.hops >= 0 ? ctx.t('road.pathDirect', { hops: o.info.hops }) : ctx.t('road.pathFlood');
    const line = why ? ctx.t('road.viaMeshWhy', { why, path }) : ctx.t('road.viaMesh', { path });
    return line + (o.info?.contact === 'added' ? ` ${ctx.t('road.contactAdded')}` : '');
  }
  return why ? ctx.t('road.viaMqttWhy', { why }) : null;
}
