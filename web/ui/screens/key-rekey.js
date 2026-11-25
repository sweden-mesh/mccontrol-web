// The key tab's "Replace the key on your nodes" (W-44): the round of lib/jobs/rekey.js as the owner
// walks it. Make the next key, save it, send it to one node at a time (offered with the key in
// use, proved with the next key), then finish or abort. The next key itself stays in the keyring
// (lib/key/keyring.js, `rekey*`); this screen holds handles and public keys only. The per-node
// state is kept with the owner's data (stores.meta, lib/jobs/rekey.js META_ID), so a reload or an
// auto-lock in the middle loses nothing.
//
// One node at a time, each send once: a second send starts only when the owner presses for it.
import { h } from '../dom.js';
import { confirm, download, explain, nameOf, put } from './node-kit.js';
import { roadLine } from './road-kit.js';
import { errorLine, groupedHex, passField } from './key-kit.js';
import { currentHandle, keyring, keyStatus, onKeyStatus } from './key-session.js';
import { services } from './node-services.js';
import { isDemo } from '../demo/mode.js';
import { companion } from '../companion-session.js';
import { brokerText } from './key-register.js';
import { CompanionError } from '../../lib/mesh/companion.js';
import { autoRelay, isFlood, relayCandidates, routesFor } from '../../lib/jobs/relay.js';
import {
  META_ID, RekeyError, STATES, WHY, abortRefusal, finishRefusal, rotate, start, summary, view,
} from '../../lib/jobs/rekey.js';

// What survives a redraw of the key tab while the page lives: the send under way, and what each
// node last answered, in words.
let running = null;                 // { node } while a node is being sent to
const said = new Map();             // node -> [line]
const through = new Map();          // node -> the relay (its node) chosen for a node without Wi-Fi
const watchers = new Set();
const changed = () => { for (const fn of [...watchers]) fn(); };

// Whole minutes left of a waiting key's hour, at least 1 while any time is left.
export const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / 60000));

// The nodes in the order to send: behind a relay first, the relays last (a relay on the next key
// no longer carries the old key's forwards), by name within each.
export function sendOrder(rules, devices, lang) {
  const rank = (d) => (rules.deviceMeshOnly(d) ? 0 : rules.canRelay(d.ver) === true && d.alive?.relay ? 2 : 1);
  return [...devices].sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b), lang));
}

// The relays that can carry a command to `target` now without a flood: [{ node, name, route }],
// the one auto would take first. A flood is the owner's word each time and is not offered here.
export function relayChoices(rules, devices, target, now) {
  const first = autoRelay(rules, devices, target, now)?.relay.node ?? null;
  return relayCandidates(rules, devices, target, now)
    .map((c) => ({ node: c.device.node, name: nameOf(c.device), route: routesFor(c).find((r) => !isFlood(r)) || null }))
    .filter((c) => c.route)
    .sort((a, b) => (b.node === first) - (a.node === first));
}

function busy(button, on) { button.disabled = on; button.setAttribute('aria-busy', String(on)); }

// `onRound(active)`: told on every draw whether a replacement is under way (the key tab hides
// "Replace the key in this browser" meanwhile).
export function rekeyBlock(ctx, { onRound = () => {} } = {}) {
  const { t } = ctx;
  const body = h('div', {});
  const root = h('section', { class: 'key-block', 'aria-labelledby': 'rekey-title' }, h('h3', { id: 'rekey-title' }, t('rekey.title')), body);
  const ring = keyring();
  const demo = isDemo();
  let svc = null;
  let drawing = 0;

  const loadRound = () => svc.stores.meta.get(META_ID);
  const saveRound = (round) => svc.stores.meta.set(META_ID, round);

  // The round the keyring's next key belongs to; made again when the owner's data lost it.
  async function roundFor(status) {
    let round = (await loadRound()) || null;
    if (!status.rekey) {
      if (round) await saveRound(null);      // left over from a round that ended elsewhere
      return null;
    }
    if (!round || round.next !== status.rekey.publicKeyHex.toUpperCase()) {
      round = start({ inUse: status.publicKeyHex, next: status.rekey.publicKeyHex, now: Date.now() });
      await saveRound(round);
    }
    return round;
  }

  async function draw() {
    const mine = ++drawing;
    try {
      // Asked of the keyring itself: the session's copy is a step behind right after a change made here.
      const status = await ring.status();
      if (!status.exists) return;
      onRound(Boolean(status.rekey));
      svc = await services(status.publicKeyHex);
      const round = await roundFor(status);
      const devices = await svc.stores.devices.list();
      if (mine !== drawing || !root.isConnected) return;
      if (!round) put(body, intro(status), replaced(status));
      else if (!status.rekey.backup) put(body, nextKey(status), saveStep(status), endRow(round, devices, { finish: false }));
      else put(body, nextKey(status), nodes(round, devices, status), endRow(round, devices, { finish: true }));
    } catch (err) {
      if (mine === drawing) put(body, h('p', { class: 'err' }, err.message));
    }
  }

  // -- no round: what it is, and the way in ---------------------------------------------------

  function intro(status) {
    const err = errorLine();
    const pass = demo ? null : passField(t, { label: t('unlock.pass'), autocomplete: 'current-password', name: 'passphrase', hint: t('rekey.startPassHint') });
    const go = h('button', { type: 'submit', class: 'button' }, t('rekey.start'));
    const form = h('form', { class: 'stack', novalidate: true }, pass?.el, h('div', { class: 'row' }, go), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (status.locked || !currentHandle()) { err.textContent = t('send.locked'); return; }
      if (pass && !pass.input.value) { err.textContent = t('unlock.problem.empty'); pass.input.focus(); return; }
      busy(go, true);
      try {
        const next = await ring.rekeyStart(pass ? pass.input.value : '');
        await saveRound(start({ inUse: status.publicKeyHex, next, now: Date.now() }));
        if (demo) await ring.rekeyBackup('');
        said.clear();
        ctx.announce(t('rekey.started'));
        draw();
      } catch (ex) {
        err.textContent = /passphrase is wrong/.test(ex.message) ? t('unlock.wrong') : ex.message;
        busy(go, false);
      }
    });
    return [
      h('p', {}, t('rekey.body')),
      h('ul', { class: 'cost' }, h('li', {}, t('rekey.how1')), h('li', {}, t('rekey.how2')), h('li', {}, t('rekey.how3'))),
      h('details', { class: 'block' }, h('summary', {}, t('rekey.start')), form),
    ];
  }

  // Keys this one replaced, still kept here sealed: their backup file, and forgetting them.
  function replaced(status) {
    if (!status.replaced.length) return null;
    return [h('h4', {}, t('rekey.replacedTitle')), h('p', {}, t('rekey.replacedBody')),
      ...status.replaced.map((r) => {
        const at = new Date(r.at).toLocaleString(ctx.lang, { dateStyle: 'medium', timeStyle: 'short' });
        const line = h('p', {}, h('code', { translate: 'no' }, `${r.publicKeyHex.slice(0, 8)}…`), ' ', t('rekey.replacedAt', { at }));
        if (demo) return line;
        const err = errorLine();
        const pass = passField(t, { label: t('unlock.pass'), autocomplete: 'current-password', name: 'passphrase' });
        const go = h('button', { type: 'submit', class: 'button' }, t('unlock.download'));
        const form = h('form', { class: 'stack', novalidate: true }, pass.el, h('div', { class: 'row' }, go), err);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          busy(go, true);
          try {
            const file = await ring.replacedBackup(r.publicKeyHex, pass.input.value);
            download(file.filename, file.text, 'application/json');
            pass.input.value = '';
            err.textContent = '';
            ctx.announce(t('unlock.savedAs', { file: file.filename }));
          } catch { err.textContent = t('unlock.wrong'); } finally { busy(go, false); }
        });
        const forget = h('button', { type: 'button', class: 'tool tool-danger' }, t('rekey.forget'));
        forget.addEventListener('click', async () => {
          const ok = await confirm(ctx, { title: t('rekey.forgetTitle', { key: r.publicKeyHex.slice(0, 8) }),
            lines: [t('rekey.forgetBody')], confirmLabel: t('rekey.forget'), danger: true });
          if (!ok) return;
          await ring.forgetReplaced(r.publicKeyHex);
          ctx.announce(t('rekey.forgotten'));
          draw();
        });
        return [line, h('details', { class: 'block' }, h('summary', {}, t('rekey.replacedSave')), form), h('div', { class: 'row' }, forget)];
      })];
  }

  // -- a round ---------------------------------------------------------------------------------

  const nextKey = (status) => [
    h('p', {}, t('rekey.nextKey')),
    h('p', { class: 'pubkey' }, h('code', { translate: 'no' }, groupedHex(status.rekey.publicKeyHex))),
  ];

  // The new key is saved before any node hears of it: a node that takes it obeys nothing else.
  function saveStep() {
    const err = errorLine();
    const pass = passField(t, { label: t('unlock.pass'), autocomplete: 'current-password', name: 'passphrase', hint: t('unlock.backupNeedsPass') });
    const go = h('button', { type: 'submit', class: 'button' }, t('unlock.download'));
    const form = h('form', { class: 'stack', novalidate: true }, pass.el, h('div', { class: 'row' }, go), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pass.input.value) { err.textContent = t('unlock.problem.empty'); pass.input.focus(); return; }
      busy(go, true);
      try {
        const file = await ring.rekeyBackup(pass.input.value);
        download(file.filename, file.text, 'application/json');
        ctx.announce(t('unlock.savedAs', { file: file.filename }));
        draw();
      } catch { err.textContent = t('unlock.wrong'); busy(go, false); }
    });
    return [h('p', { class: 'warn-text' }, t('rekey.saveFirst')), form];
  }

  const stateText = (v) => (v.state === STATES.cannot ? t(`rekey.why.${v.why}`)
    : v.state === STATES.sent ? t('rekey.state.sent', { min: minutesLeft(v.left) })
      : v.expired ? t('rekey.state.expired') : t(`rekey.state.${v.state}`));

  // What one send came to, in the words every other screen uses for a result.
  function resultLine(device, { step, outcome }) {
    const x = explain(ctx, svc, outcome?.result ?? null, device, outcome?.road, outcome?.info, outcome?.event?.advice);
    const text = x.kind === 'ok' ? x.text : `${x.text}. ${x.help}`;
    const road = outcome ? roadLine(ctx, outcome) : null;
    return `${t(`rekey.step.${step}`)}: ${text}${road ? `${/[.!?]$/.test(text) ? '' : '.'} ${road}` : ''}`;
  }

  // The road to one node: MQTT; for a node without Wi-Fi the companion when one is connected, else
  // the chosen relay by a way that is no flood, else auto (which then says what is missing).
  async function roadFor(d) {
    if (!svc.rules.deviceMeshOnly(d)) return { road: 'mqtt' };
    if (!demo && companion()) return { road: 'mesh' };
    const choices = relayChoices(svc.rules, await svc.stores.devices.list(), d, Date.now());
    const pick = choices.find((c) => c.node === through.get(d.node)) || choices[0];
    return pick ? { road: 'relay', relay: { node: pick.node, route: pick.route } } : { road: 'auto' };
  }

  // Why nothing was sent, as the send screen says it.
  const whyText = (err) => (err?.code === 'locked' ? t('send.locked')
    : err instanceof RekeyError ? (err.code in WHY ? t(`rekey.why.${err.code}`) : err.message)
    : err instanceof CompanionError ? t('send.why.companion', { detail: err.message })
      : err?.code ? t(`send.why.${err.code}`, err.vars) : brokerText(t, err?.message || String(err)));

  // Offer and prove on the nodes in `list`, one after another; each node is sent to once.
  async function send(list, { proveOnly = false } = {}) {
    if (running) return;
    for (const device of list) {
      running = { node: device.node };
      changed();
      try {
        const fresh = (await svc.stores.devices.get(device.node)) || device;
        const out = await rotate({ load: loadRound, save: saveRound, rules: svc.rules, device: fresh, proveOnly,
          send: async (signer, command, d) => {
            const jobs = signer === 'new' ? svc.nextJobs : svc.jobs;
            const got = await jobs.send({ command, nodes: [d.node], ...(await roadFor(d)) });
            return got.outcomes[0];
          } });
        said.set(device.node, out.steps.map((st) => resultLine(fresh, st)));
      } catch (err) {
        said.set(device.node, [whyText(err)]);
        if (err?.code === 'locked') break;
      }
    }
    running = null;
    changed();
  }

  function nodes(round, devices, status) {
    const now = Date.now();
    const rows = sendOrder(svc.rules, devices, ctx.lang).map((device) => ({ device, v: view(round, svc.rules, device, now) }));
    const off = Boolean(running) || status.locked;
    const air = (d) => svc.rules.deviceMeshOnly(d);
    const ask = async (list, proveOnly) => {
      const one = list.length === 1 ? list[0] : null;
      const ok = await confirm(ctx, {
        title: one ? t('rekey.sendTitle', { name: nameOf(one) }) : t('rekey.sendAllTitle', { n: list.length }),
        lines: [t(proveOnly ? 'rekey.proveBody' : 'rekey.sendBody'), list.some(air) ? t('rekey.sendAir') : null].filter(Boolean),
        confirmLabel: t(proveOnly ? 'rekey.prove' : 'rekey.send'),
      });
      if (ok) send(list, { proveOnly });
    };
    const act = (label, list, proveOnly = false) => {
      const b = h('button', { type: 'button', class: 'tool', disabled: off }, label);
      b.addEventListener('click', () => ask(list, proveOnly));
      return b;
    };
    // Under the name of a node without Wi-Fi: the way a command takes to it.
    const viaLine = (device, all, at) => {
      if (!demo && companion()) return h('span', { class: 'node-id' }, t('rekey.viaCompanion'));
      const choices = relayChoices(svc.rules, all, device, at);
      if (!choices.length) return h('span', { class: 'node-id' }, t('rekey.viaNone'));
      const select = h('select', { 'aria-label': t('rekey.via', { name: nameOf(device) }), disabled: off },
        choices.map((c) => h('option', { value: c.node, selected: c.node === through.get(device.node) }, `${c.name} (${t(`road.routeShort.${c.route}`)})`)));
      select.addEventListener('change', () => through.set(device.node, select.value));
      return h('label', { class: 'node-id' }, t('road.relay'), ' ', select);
    };
    const cell = (label, ...children) => h('td', {}, h('span', { class: 'cell-label' }, label), ...children);
    const table = h('table', { class: 'rekey-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('rekey.col.node')), h('th', { scope: 'col' }, t('rekey.col.state')),
        h('th', { scope: 'col' }, t('rekey.col.result')), h('th', { scope: 'col' }, t('rekey.col.do')))),
      h('tbody', {}, rows.map(({ device, v }) => {
        const here = running?.node === device.node;
        const lines = said.get(device.node) || [];
        const buttons = v.state === STATES.cannot || v.state === STATES.proved ? []
          : v.state === STATES.sent ? [act(t('rekey.prove'), [device], true), act(t('rekey.sendAgain'), [device])]
            : [act(t(v.state === STATES.failed || v.expired ? 'rekey.sendAgain' : 'rekey.send'), [device])];
        return h('tr', {},
          h('th', { scope: 'row' }, nameOf(device), air(device) && buttons.length ? viaLine(device, devices, now) : null),
          cell(t('rekey.col.state'), stateText(v)),
          cell(t('rekey.col.result'), here ? h('span', { role: 'status' }, t('rekey.sending')) : lines.map((l) => h('p', { class: 'hint-line' }, l))),
          cell(t('rekey.col.do'), h('div', { class: 'row wrap' }, buttons)));
      })));
    const wifi = rows.filter(({ device, v }) => !air(device) && (v.state === STATES.waiting || v.state === STATES.failed)).map((r) => r.device);
    return [
      h('p', {}, t('rekey.nodesBody')),
      status.locked ? h('p', { class: 'err' }, t('send.locked')) : null,
      rows.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, t('rekey.noNodes')),
      wifi.length > 1 ? h('div', { class: 'row' }, act(t('rekey.sendAll', { n: wifi.length }), wifi)) : null,
      h('p', { class: 'hint-line' }, t('rekey.untilFinish')),
    ];
  }

  // Finish and abort, each behind a dialog that says which nodes are where.
  function endRow(round, devices, { finish }) {
    const sum = summary(round, svc.rules, devices, Date.now());
    const list = (ds) => ds.map((d) => nameOf(d.device || d)).join(', ');
    const off = Boolean(running);
    const done = h('button', { type: 'button', class: 'button', disabled: off }, t('rekey.finish'));
    done.addEventListener('click', async () => {
      const refusal = finishRefusal(sum, false);
      const ok = await confirm(ctx, {
        title: t('rekey.finishTitle'),
        lines: [
          sum.proved.length ? t('rekey.finishProved', { names: list(sum.proved) }) : t('rekey.finishNone'),
          sum.pending.length ? t('rekey.finishLeft', { names: list(sum.pending) }) : null,
          sum.sent.length ? t('rekey.maybeTook', { names: list(sum.sent) }) : null,
          sum.cannot.length ? t('rekey.finishUsb', { names: list(sum.cannot) }) : null,
          t('rekey.finishKept'),
        ].filter(Boolean),
        confirmLabel: t(refusal ? 'rekey.finishLeave' : 'rekey.finishGo'), danger: Boolean(refusal),
      });
      if (!ok) return;
      // The dialog's button is the owner's word for leaving nodes behind.
      if (finishRefusal(sum, Boolean(refusal))) return;
      if (!currentHandle() || !ring.rekeyHandle()) { ctx.notify(t('send.locked'), { kind: 'error' }); return; }
      try {
        await svc.copyTo(round.next);
        await ring.rekeyFinish();
        await saveRound(null);
        said.clear();
        ctx.notify(t('rekey.finished'));
      } catch (err) { ctx.notify(err.message, { kind: 'error' }); }
    });
    const stop = h('button', { type: 'button', class: 'tool tool-danger', disabled: off }, t('rekey.abort'));
    const taken = abortRefusal(sum);
    if (taken) stop.disabled = true;
    stop.addEventListener('click', async () => {
      const ok = await confirm(ctx, {
        title: t('rekey.abortTitle'),
        lines: [t('rekey.abortBody'), sum.sent.length ? t('rekey.maybeTook', { names: list(sum.sent) }) : null].filter(Boolean),
        confirmLabel: t('rekey.abort'), danger: true,
      });
      if (!ok) return;
      try {
        await ring.rekeyAbort();
        await saveRound(null);
        said.clear();
        ctx.notify(t('rekey.aborted'));
        draw();
      } catch (err) { ctx.notify(err.message, { kind: 'error' }); }
    });
    return [
      h('div', { class: 'row wrap' }, finish ? done : null, stop),
      taken ? h('p', { class: 'hint-line' }, t('rekey.abortTaken', { names: taken.names.join(', ') })) : null,
    ];
  }

  // Redrawn when the key locks, unlocks or changes, when a send starts or ends, and each half
  // minute for the time a waiting key has left. Stops by itself once the block is off the page.
  const again = () => { if (root.isConnected) draw(); else end(); };
  watchers.add(again);
  const stopKey = onKeyStatus(() => { if (!body.contains(document.activeElement) || !document.activeElement.matches('input')) again(); });
  const tick = setInterval(() => { if (!root.isConnected) end(); else if (keyStatus().rekey?.backup && !running && !body.contains(document.activeElement) && !document.querySelector('dialog[open]')) draw(); }, 30000);
  function end() { watchers.delete(again); stopKey(); clearInterval(tick); }
  ctx.signal.addEventListener('abort', end, { once: true });
  // Filled once the block is on the page (draw() gives up on a block that is not).
  setTimeout(draw, 0);
  return root;
}
