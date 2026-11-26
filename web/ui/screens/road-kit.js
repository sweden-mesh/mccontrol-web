// The roads on the screens (W-16, OTM-9e): the road choice (Auto / MQTT / Mesh / a relay), the relay
// picker (which of your nodes sends it, by which route, with the flood confirmation), the companion
// control (connect by Bluetooth, USB or the network through mccontrol-bridge, its state, what this
// browser cannot do), and the words
// for which road a result took. Used by the send panel (node and send screens) and settings.
import { h } from '../dom.js';
import { confirm, field, nameOf, put, useStyles } from './node-kit.js';
import { isFlood, noRelayWhy, parseRelayState, pathHops, relayCandidates, routesFor } from '../../lib/jobs/relay.js';
import { distanceKm } from '../standard/neighbours-data.js';
import { connect, disconnect, onCompanion, state, support } from '../companion-session.js';
import { bridgeAddress, companionKind, meshAfterMins } from './settings-store.js';

let count = 0;

// A fieldset of radios. `meshOnly`: MQTT cannot reach the node, so it is not offered. `relay`:
// the send is to one node, so a relay may carry it; the radio is off until setRelay(true) says a
// node of yours can relay, and setRelay(false, why) says in one line why none can.
export function roadChoice(ctx, { initial = 'mqtt', meshOnly = false, relay = false, onChange }) {
  const name = `road-${count += 1}`;
  const hintId = `${name}-hint`;
  const value = meshOnly && initial === 'mqtt' ? 'auto' : initial;
  const inputs = {};
  const radios = ['auto', 'mqtt', 'mesh', relay ? 'relay' : null].filter(Boolean).map((r) => {
    const input = h('input', { type: 'radio', name, value: r, checked: r === value, disabled: (meshOnly && r === 'mqtt') || r === 'relay' });
    input.addEventListener('change', () => { if (input.checked) onChange(r); }, { signal: ctx.signal });
    inputs[r] = input;
    return h('label', {}, input, ' ', ctx.t(`road.${r}`));
  });
  const relayWhy = h('p', { class: 'hint-line', hidden: true });
  const el = h('fieldset', { class: 'choice road-choice', 'aria-describedby': hintId },
    h('legend', {}, ctx.t('road.legend')), radios,
    h('p', { class: 'hint-line', id: hintId }, ctx.t('road.hint', { mins: meshAfterMins() }), ' ',
      h('a', { href: '#/help/mesh' }, ctx.t('road.help'))), relayWhy);
  function setRelay(offered, why = '') {
    if (!inputs.relay) return;
    inputs.relay.disabled = !offered;
    relayWhy.textContent = offered ? '' : why;
    relayWhy.hidden = offered || !why;
  }
  return { el, value, setRelay };
}

// Which of your nodes sends the command, and by which route (relay.js). use(device, all) fills it
// for one target from the device list; choice() is { node, route } or null; the choice is kept on
// the target. "Check neighbours" reads one relay's `neighbors` over MQTT (no airtime) and marks
// whether it hears the target; "Read budget" asks the relay what is left of its hour. Neither
// runs by itself. Relays of which nothing is known are listed nearest first, said as a guess.
export function relayPicker(ctx, svc, { onChange = () => {} } = {}) {
  useStyles();
  const { t } = ctx;
  const relaySel = h('select', {});
  const routeSel = h('select', {});
  const check = h('button', { type: 'button', class: 'tool' }, t('road.checkNeighbours'));
  const budget = h('button', { type: 'button', class: 'tool' }, t('road.readBudget'));
  const note = h('p', { class: 'hint-line', role: 'status' });
  const fields = h('div', { class: 'stack' },
    field(t('road.relayWhich'), relaySel), field(t('road.relayRoute'), routeSel, t('road.relayHint')));
  const el = h('div', { class: 'stack relay-picker' }, fields, h('div', { class: 'row wrap' }, check, budget), note);
  let device = null;
  let all = [];
  let list = [];

  const at = (d) => ({ lat: d?.fleet?.lat, lng: d?.fleet?.lng });
  const current = () => list.find((c) => c.device.node === relaySel.value) || null;
  const routeWords = (c, route) => t(`road.route.${route}`, { hops: pathHops(c.path) ?? 0 });
  const known = (c) => (c.hears === true ? (c.snr !== null ? t('road.hears.yesSnr', { snr: Math.round(c.snr * 10) / 10 }) : t('road.hears.yes')) : c.path ? t('road.hears.path', { hops: pathHops(c.path) })
    : c.hears === false ? t('road.hears.no') : c.km !== null ? t('road.hears.guess', { km: Math.round(c.km) }) : t('road.hears.unknown'));

  function drawRoutes(keep = null) {
    const c = current();
    put(routeSel, c ? routesFor(c).map((r) => h('option', { value: r }, routeWords(c, r))) : []);
    if (c && keep && routesFor(c).includes(keep)) routeSel.value = keep;
    check.disabled = budget.disabled = !c;
  }

  function draw(keep = null) {
    const found = relayCandidates(svc.rules, all, device).map((c) => ({ ...c, km: distanceKm(at(device), at(c.device)) }));
    const blank = (c) => c.hears === null && !c.path;
    const guessed = found.filter(blank).sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
    list = [...found.filter((c) => !blank(c) && c.hears !== false), ...guessed, ...found.filter((c) => c.hears === false)];
    put(relaySel, list.map((c) => h('option', { value: c.device.node }, `${nameOf(c.device)} · ${known(c)}`)));
    if (keep?.relay && list.some((c) => c.device.node === keep.relay)) relaySel.value = keep.relay;
    drawRoutes(keep?.route);
  }

  const choice = () => (current() && routeSel.value ? { node: relaySel.value, route: routeSel.value } : null);
  const remember = () => {
    const c = choice();
    if (device && c) svc.stores.devices.update(device.node, { relayChoice: { relay: c.node, route: c.route } }).then((d) => { device = d; }).catch(() => {});
    onChange();
  };
  relaySel.addEventListener('change', () => { drawRoutes(); remember(); }, { signal: ctx.signal });
  routeSel.addEventListener('change', remember, { signal: ctx.signal });

  const failed = (err) => (err.code ? t(`send.why.${err.code}`, err.vars) : err.message);
  async function ask(work) {
    const c = current();
    if (!c || !device) return;
    check.disabled = budget.disabled = true;
    note.textContent = t('road.asking', { relay: nameOf(c.device) });
    try { note.textContent = await work(c); } catch (err) { note.textContent = failed(err); }
    if (!ctx.signal.aborted) drawRoutes(routeSel.value);
  }
  check.addEventListener('click', () => ask(async (c) => {
    const out = await svc.jobs.checkNeighbours({ relay: c.device.node, target: device.node });
    const kept = choice();
    device = (await svc.stores.devices.get(device.node)) || device;
    draw({ relay: kept?.node, route: out.hears === true ? 'neighbour' : kept?.route });
    remember();
    const names = { relay: nameOf(c.device), target: nameOf(device) };
    return t(out.hears === true ? 'road.hearsYes' : out.hears === false ? 'road.hearsNo' : out.result ? 'road.hearsUnknown' : 'road.relayQuiet', names);
  }), { signal: ctx.signal });
  budget.addEventListener('click', () => ask(async (c) => {
    const out = await svc.jobs.send({ command: 'get relay', nodes: [c.device.node], road: 'mqtt' });
    const result = out.outcomes[0]?.result;
    const s = result?.ok ? parseRelayState(result.reply) : null;
    const relay = nameOf(c.device);
    if (!result) return t('road.relayQuiet', { relay });
    if (!s) return t('road.budgetUnknown', { relay });
    if (!s.on) return t('road.budgetOff', { relay });
    return s.left === null ? t('road.budgetUnknown', { relay }) : t('road.budget', { relay, left: s.left, floods: s.floods });
  }), { signal: ctx.signal });

  let inlineEl = null;
  return {
    el,
    // The two choosers on one line, for the command area: the relay and the route are then chosen
    // where the command is typed, and `el` keeps the checks (neighbours, budget) and their answer.
    inline() {
      if (inlineEl) return inlineEl;
      relaySel.setAttribute('aria-label', t('road.relayWhich'));
      routeSel.setAttribute('aria-label', t('road.relayRoute'));
      inlineEl = h('span', { class: 'relay-inline' }, relaySel, routeSel);
      fields.replaceWith(h('p', { class: 'hint-line' }, t('road.relayHint')));
      return inlineEl;
    },
    // The same node again keeps what was read and chosen here since (the caller's copy may be older).
    use(d, devices) {
      const same = Boolean(device && d && device.node === d.node);
      if (!same) note.textContent = '';
      device = same && String(device.updated) > String(d.updated) ? device : d;
      all = devices;
      draw((same && choice() ? { relay: relaySel.value, route: routeSel.value } : null) || device?.relayChoice || null);
    },
    offered: () => list.length > 0,
    why() { const w = device ? noRelayWhy(svc.rules, all, device) : null; return w ? t(`road.relayNone.${w.code.slice(5)}`, w.vars) : ''; },
    choice,
    // "Gisebo, direct neighbour (no hops)", or '' while nothing is chosen.
    words() { const c = current(); return c && routeSel.value ? t('road.relayBrief', { relay: nameOf(c.device), route: routeWords(c, routeSel.value) }) : ''; },
    // A zero-hop send through a relay that has not been checked to hear the node is a guess.
    unchecked() { const c = current(); return Boolean(c && routeSel.value === 'neighbour' && c.hears !== true); },
    // A flood is asked for each time, with what it costs; true only from the dialog's own button.
    confirmFlood(command) {
      const c = current();
      if (!c || !isFlood(routeSel.value)) return Promise.resolve(false);
      return confirm(ctx, {
        title: t('road.floodTitle'),
        lines: [h('p', {}, h('code', {}, command), ' → ', nameOf(device)),
          t(routeSel.value === 'flood' ? 'road.floodBody' : 'road.floodBodyWide', { relay: nameOf(c.device) }), t('road.floodBudget')],
        confirmLabel: t('road.floodButton'), danger: true,
      });
    },
  };
}

// One line for the NODE tile's command area: the relay and route chosen, as a button that opens
// the picker in a dialog (as the companion's line opens its chooser). draw() after a change.
export function relayBrief(ctx, picker) {
  // Beside the two choosers: what the route is worth (a zero-hop send through a relay not checked
  // to hear the node is a guess), and the button that opens the checks in a dialog.
  const inline = picker.inline();
  const doubt = h('span', { class: 'muted relay-doubt' });
  const button = h('button', { type: 'button', class: 'link-button companion-brief' }, ctx.t('road.relayCheck'));
  const el = h('span', { class: 'relay-brief' }, inline, doubt, button);
  const draw = () => { doubt.textContent = picker.unchecked() ? ctx.t('road.unchecked') : ''; };
  inline.addEventListener('change', draw, { signal: ctx.signal });
  button.addEventListener('click', () => {
    const id = `relay-${count += 1}`;
    const done = h('button', { type: 'button', class: 'button' }, ctx.t('road.relayDone'));
    const dialog = h('dialog', { class: 'dlg', 'aria-labelledby': id, closedby: 'any' },
      h('h2', { id }, ctx.t('road.relay')), picker.el, h('div', { class: 'row-end' }, done));
    done.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); draw(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }, { signal: ctx.signal });
  draw();
  return { el, draw };
}

// The relay's choice for a send, asking first when it is a flood: { node, route, confirmed }, or
// null when nothing is chosen or the flood was not confirmed.
export async function relayForSend(picker, command) {
  const c = picker.choice();
  if (!c) return null;
  const flood = isFlood(c.route);
  const confirmed = flood ? await picker.confirmFlood(command) : false;
  return flood && !confirmed ? null : { ...c, confirmed };
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
        // The button on the left; on the right what this way needs, and why it is missing here.
        return h('li', {}, b, h('div', { class: 'chooser-about' }, h('p', {}, ctx.t(`companion.needs.${kind}`)),
          why ? h('p', { class: 'hint-line', id: `${id}-${kind}` }, why) : null));
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
  if (o.road === 'relay') {
    const vars = { relay: o.info?.relayName || o.info?.relay || '', route: ctx.t(`road.routeShort.${o.info?.route}`), why };
    return ctx.t(why ? 'road.viaRelayWhy' : 'road.viaRelay', vars)
      + (Number.isFinite(o.info?.snr) ? ` ${ctx.t('road.relaySnr', { snr: o.info.snr })}` : '');
  }
  if (o.road === 'mesh') {
    const path = !o.info ? '' : o.info.hops >= 0 ? ctx.t('road.pathDirect', { hops: o.info.hops }) : ctx.t('road.pathFlood');
    const line = why ? ctx.t('road.viaMeshWhy', { why, path }) : ctx.t('road.viaMesh', { path });
    return line + (o.info?.contact === 'added' ? ` ${ctx.t('road.contactAdded')}` : '');
  }
  return why ? ctx.t('road.viaMqttWhy', { why }) : null;
}
