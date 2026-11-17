// The mesh road on the screens (W-16): the road choice (Auto / MQTT / Mesh), the companion
// control (connect by Bluetooth or USB, its state, what this browser cannot do), and the words
// for which road a result took. Used by the send panel (node and send screens) and settings.
import { h } from '../dom.js';
import { put, useStyles } from './node-kit.js';
import { connect, disconnect, onCompanion, state, support } from '../companion-session.js';
import { companionKind, meshAfterMins } from './settings-store.js';

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
      : s.status === 'connecting' ? ctx.t('companion.connecting')
        : s.status === 'error' ? ctx.t('companion.error', { error: s.error }) : ctx.t('companion.none');
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
  return h('div', { class: 'companion' }, status, buttons, note);
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
