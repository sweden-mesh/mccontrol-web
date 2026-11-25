// One node (W-7, W-8, W-19), "Firmware, name and region" (#nodeinfo/<8 hex>), reworked in W-26h:
// its name, region and notes at the top, what is known about it with the age of each fact, its
// firmware with an "update available" mark and the update button, one "Set/update region" action
// (W-26i: the shipped add-scope steps; the owner's own sets stay in the palette and Setup) and the
// "All history" link, and for a node that can relay the switch for it. No Send and no results
// here: the board's command line and HISTORY have both.
import { h } from '../dom.js';
import { dataChanged } from '../tiles/sources.js';   // the page's lists follow a node added, renamed or forgotten here
import { deriveFacts } from '../../lib/store/index.js';
import { lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { updateAvailable } from '../../lib/jobs/releases.js';
import { blocker } from '../../lib/jobs/checks.js';
import { scheme } from '../../lib/jobs/scheme.js';
import { relaying } from '../../lib/jobs/relay.js';
import {
  confirm, explain, field, nameOf, progressLine, screen, volts, when, withServices, put, lockedNote } from './node-kit.js';
import { runSetPanel } from './sets.js';

// The steps of "Set/update region" (W-26i): the shipped add-scope set, as exported from Python, so
// the action is here even when the owner has removed or changed their copy of the set.
export const REGION_SET = 'add-scope';

export const route = 'node';
export const title = 'nav.node';

export function factList(ctx, svc, device, events) {
  const { facts, raw } = deriveFacts(device, events, svc.rules.parseFacts);
  const labels = svc.data.facts.labels.map(([k]) => k);
  const label = Object.fromEntries(svc.data.facts.labels);
  const keys = Object.keys(facts).sort((a, b) => {
    const ia = labels.indexOf(a); const ib = labels.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  if (!keys.length && !Object.keys(raw).length) return h('p', { class: 'muted' }, ctx.t('node.noFacts'));
  const row = (name, value, f) => [h('dt', {}, name), h('dd', {}, h('code', {}, value), ' ',
    h('span', { class: 'muted small' }, when(ctx, f.at), f.verified === null ? ` · ${ctx.t('node.unsigned')}` : ''))];
  return h('dl', { class: 'facts' },
    keys.flatMap((k) => row(label[k] || k, facts[k].value, facts[k])),
    Object.entries(raw).flatMap(([cmd, r]) => row(cmd, r.reply.length > 120 ? `${r.reply.slice(0, 120)}…` : r.reply, r)));
}

// Whether this node can take `release` over the control plane now: an update is out, the deny
// list and the node's firmware admit `ota update`.
export function canUpdate(svc, device, release) {
  if (!device?.ver || !updateAvailable(svc.rules, device.ver, release)) return false;
  return !blocker(svc.rules, { command: 'ota update', device }) && svc.rules.admits(device.ver, 'ota update');
}

// The update, as the owner runs it: a dialog that says what it costs, `ota check`, then
// `ota update` when the node says an update fits, then `ver` until it reports the new version.
// `out` shows the stages; `control` is disabled meanwhile.
export async function runUpdate(ctx, svc, device, release, { out, control = null, redraw = () => {} }) {
  const ok = await confirm(ctx, {
    title: ctx.t('update.confirmTitle', { name: nameOf(device) }),
    lines: [ctx.t('update.confirmBody', { from: shortVersion(svc.rules, device.ver), to: release.tag })],
    confirmLabel: ctx.t('update.confirmButton'),
    danger: true,
  });
  if (!ok) return;
  if (control) control.disabled = true;
  const bar = progressLine();
  put(out, bar.el);
  try {
    const res = await svc.jobs.update({
      node: device.node, target: release.tag, signal: ctx.signal, check: true,
      onStage: (s) => bar.set(s.total ? s.elapsed / s.total : null, ctx.t(`update.stage.${s.stage}`, { secs: s.elapsed ?? 0, version: s.version ?? '' })),
    });
    const msg = res.ok ? ctx.t('update.done', { version: res.version })
      : res.result ? ctx.t('update.refused', { code: res.result.code })
        : res.reason?.code === 'noUpdate' ? ctx.t('update.stage.noUpdate', { reply: res.reply || '' })
          : ctx.t(`update.stage.${res.reason?.code || 'timeout'}`, { version: res.version || '?' });
    put(out, h('p', { role: 'status' }, msg));
    ctx.notify(msg, { kind: res.ok ? 'info' : 'warning' });
    if (res.ok) redraw();
  } catch (err) {
    put(out, h('p', { class: 'err', role: 'alert' }, err.code === 'locked' ? lockedNote(ctx) : err.message));
  } finally { if (control) control.disabled = false; }
}

// W-19: the version, the mark, and the update with its stages.
export function firmwareBlock(ctx, svc, device, release, page, redraw) {
  const wrap = h('div', { class: 'stack' });
  if (!device.ver) {
    wrap.append(h('p', {}, ctx.t('update.unknown')));
    return wrap;
  }
  const up = updateAvailable(svc.rules, device.ver, release);
  wrap.append(h('p', {}, h('code', {}, device.ver), ' ',
    up ? h('span', { class: 'tag tag-update' }, ctx.t('update.available')) : null,
    up === false ? h('span', { class: 'muted' }, ctx.t('update.current')) : null));
  if (!up) return wrap;
  const block = blocker(svc.rules, { command: 'ota update', device });
  const admitted = !block && svc.rules.admits(device.ver, 'ota update');
  const pageLink = page ? h('a', { href: page, rel: 'noopener noreferrer', target: '_blank' }, ctx.t('update.page')) : null;
  if (!admitted) {
    wrap.append(h('p', {}, ctx.t('update.byHand', { latest: release.tag }), ' ', pageLink),
      h('p', { class: 'muted small' }, ctx.t('update.whyNot', { detail: block?.vars?.detail || device.ver })));
    return wrap;
  }
  const button = h('button', { type: 'button', class: 'button' }, ctx.t('update.button', { latest: release.tag }));
  const out = h('div', { 'aria-live': 'polite' });
  button.addEventListener('click', () => runUpdate(ctx, svc, device, release, { out, control: button, redraw }), { signal: ctx.signal });
  wrap.append(h('div', { class: 'row' }, button), out);
  return wrap;
}

// Relaying (OTM-9e): whether this node sends your commands on by radio to nodes near it, as its
// alive says, and the switch (`set relay off|own`, one signed command over MQTT). Shown for
// an Observer image of lou-20 or later only: no other node can relay.
export function relayBlock(ctx, svc, device, redraw) {
  const on = relaying(device.alive);
  const out = h('p', { 'aria-live': 'polite' });
  const buttons = ['off', 'own'].filter((v) => on === null || (v === 'own') !== on).map((value) => {
    const b = h('button', { type: 'button', class: 'tool' }, ctx.t(value === 'off' ? 'relay.switchOff' : 'relay.switchOn'));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await svc.jobs.send({ command: `set relay ${value}`, nodes: [device.node], road: 'mqtt' });
        const result = res.outcomes[0]?.result || null;
        if (result?.ok) { redraw(); return; }
        const x = explain(ctx, svc, result, device);
        out.textContent = x.kind === 'refused' ? `${x.text}: ${x.help}` : x.help;
      } catch (err) {
        put(out, err.code === 'locked' ? lockedNote(ctx) : err.code ? ctx.t(`send.why.${err.code}`, err.vars) : err.message);
      } finally { b.disabled = false; }
    }, { signal: ctx.signal });
    return b;
  });
  return h('div', { class: 'stack' },
    h('p', {}, ctx.t(on === true ? 'relay.on' : on === false ? 'relay.off' : 'relay.unknown')),
    h('p', { class: 'muted' }, ctx.t('relay.explain')), h('div', { class: 'row wrap' }, buttons), out);
}

// What the node's details say of its plane: online, offline or no longer yours (its alive), and
// its own region home -- the one place a region is shown (IATA-2).
export function nodeFacts(ctx, device) {
  const out = [];
  if (device.alive?.state) out.push(ctx.t(`alive.${device.alive.state}`));
  if (device.alive?.region && device.alive.state !== 'not-yours') out.push(ctx.t('node.regionHome', { region: device.alive.region }));
  return out;
}

export function editForm(ctx, svc, device, redraw) {
  const name = h('input', { type: 'text', value: device.name, autocomplete: 'off' });
  // The IATA code only the old scheme (lou-19 and older) addresses a node by: asked for nowhere
  // else, and only while this node needs it (no alive, no lou-20, not mesh-only, IATA-2).
  const old = scheme(svc.rules, device) === 'old' && !svc.rules.deviceMeshOnly(device);
  const region = h('input', { type: 'text', value: device.region || '', autocomplete: 'off', maxlength: '8', class: 'short' });
  const notes = h('textarea', { rows: '3' });
  notes.value = device.notes || '';
  // W-16: whether the node is mesh only (no Wi-Fi, no MQTT); by default its version says
  const meshOnly = h('select', {},
    ['auto', 'yes', 'no'].map((v) => h('option', { value: v }, ctx.t(`node.meshOnly.${v}`, { guess: ctx.t(svc.rules.meshOnly(device.ver) ? 'node.meshOnly.guessYes' : 'node.meshOnly.guessNo') }))));
  meshOnly.value = device.meshOnly === true ? 'yes' : device.meshOnly === false ? 'no' : 'auto';
  const out = h('p', { 'aria-live': 'polite' });
  const forget = h('button', { type: 'button', class: 'tool tool-danger' }, ctx.t('node.forget'));
  const form = h('form', { class: 'stack' },
    field(ctx.t('nodes.name'), name, ctx.t('node.nameHint')),
    old ? field(ctx.t('nodes.region'), region, ctx.t('node.regionHint')) : null,
    field(ctx.t('node.notes'), notes),
    field(ctx.t('node.meshOnlyLabel'), meshOnly, ctx.t('node.meshOnlyHint')),
    h('div', { class: 'row wrap' }, h('button', { type: 'submit', class: 'button' }, ctx.t('node.save')), forget), out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await svc.stores.devices.update(device.node, { name: name.value, ...(old ? { region: region.value } : {}), notes: notes.value.trim(),
        meshOnly: { yes: true, no: false }[meshOnly.value] ?? null });
      out.textContent = ctx.t('node.saved');
      redraw();
      dataChanged('devices');
    } catch (err) { out.textContent = err.message; }
  }, { signal: ctx.signal });
  forget.addEventListener('click', async () => {
    const ok = await confirm(ctx, {
      title: ctx.t('node.forgetTitle', { name: nameOf(device) }), lines: [ctx.t('node.forgetBody')],
      confirmLabel: ctx.t('node.forget'), danger: true,
    });
    if (!ok) return;
    await svc.stores.devices.remove(device.node);
    dataChanged('devices');
    ctx.notify(ctx.t('node.forgotten', { name: nameOf(device) }));
    ctx.navigate('#/nodes');
  }, { signal: ctx.signal });
  return form;
}

export function render(ctx) {
  const id = String(ctx.args[0] || '').toUpperCase();
  const body = h('div', {});
  const el = screen('node', ctx.t('nav.node'), body);
  const heading = el.querySelector('h1');
  withServices(ctx, body, async (svc) => {
    const release = await svc.releases().catch(() => null);
    const page = await svc.releasePage().catch(() => null);
    const regionSteps = svc.data.brokers.default_sets?.[REGION_SET] || null;
    async function draw() {
      const device = await svc.stores.devices.get(id);
      if (!device) {
        heading.textContent = ctx.t('node.missing');
        put(body, h('p', {}, h('a', { href: '#/nodes' }, ctx.t('node.toNodes'))));
        return;
      }
      heading.textContent = nameOf(device);
      document.title = `${nameOf(device)} · mccontrol`;
      const events = await svc.stores.history.list({ node: device.node });
      const heard = lastHeard(device);
      put(body,
        h('p', { class: 'node-meta' },
          h('code', {}, device.key || device.node), ' · ', ...nodeFacts(ctx, device).flatMap((f) => [f, ' · ']),
          heard ? [ctx.t('node.heard'), ' ', when(ctx, heard)] : ctx.t('nodes.heardUnknown'),
          ' · ', volts(ctx.t, device.fleet?.batteryMv)),
        device.key ? null : h('p', { class: 'check check-caution' }, ctx.t('node.noWholeKey')),
        h('h2', {}, ctx.t('node.edit')),
        editForm(ctx, svc, device, draw),
        h('h2', {}, ctx.t('node.facts')),
        factList(ctx, svc, device, events),
        h('p', {}, h('a', { href: `#/stats/${device.node}` }, ctx.t('node.statsLink'))),
        h('h2', {}, ctx.t('update.title')),
        firmwareBlock(ctx, svc, device, release, page, draw),
        svc.rules.canRelay(device.ver) === true ? [h('h2', {}, ctx.t('relay.title')), relayBlock(ctx, svc, device, draw)] : null,
        regionSteps ? [h('h2', {}, ctx.t('node.regionSet')),
          runSetPanel(ctx, svc, { devices: [device] }, { [REGION_SET]: regionSteps },
            { only: true, argLabel: ctx.t('node.regionSetArg'), argHint: ctx.t('node.regionSetHint') })] : null,
        h('p', {}, events.length
          ? h('a', { href: `#/history/${device.node}` }, ctx.t('node.allHistory', { n: events.length }))
          : h('span', { class: 'muted' }, ctx.t('node.noHistory'))));
    }
    await draw();
  });
  return el;
}
