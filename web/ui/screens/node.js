// One node (W-7, W-8, W-19): #/node/<8 hex>. What is known about it with the age of each fact,
// its firmware with an "update available" mark and the update button, Send, the command sets,
// its recent results, and its name, region and notes. Region-wide sends are not here: they are
// an advanced action on the Send screen.
import { h } from '../dom.js';
import { deriveFacts } from '../../lib/store/index.js';
import { lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { updateAvailable } from '../../lib/jobs/releases.js';
import { blocker } from '../../lib/jobs/checks.js';
import {
  confirm, explainEvent, field, nameOf, outcomeTag, progressLine, screen, when, withServices, put, resultBody, lockedNote } from './node-kit.js';
import { sendPanel } from './send.js';
import { runSetPanel } from './sets.js';

const resLine = (x, command) => { const [text, help] = resultBody(x, command); return [h('span', { class: 'res-text' }, text), help ? h('span', { class: 'res-help' }, help) : null]; };

export const route = 'node';
export const title = 'nav.node';

function factList(ctx, svc, device, events) {
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

// W-19: the version, the mark, and the update with its stages.
function firmwareBlock(ctx, svc, device, release, page, redraw) {
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
  button.addEventListener('click', async () => {
    const ok = await confirm(ctx, {
      title: ctx.t('update.confirmTitle', { name: nameOf(device) }),
      lines: [ctx.t('update.confirmBody', { from: shortVersion(svc.rules, device.ver), to: release.tag })],
      confirmLabel: ctx.t('update.confirmButton'),
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    const bar = progressLine();
    put(out, bar.el);
    try {
      const res = await svc.jobs.update({
        node: device.node, target: release.tag, signal: ctx.signal,
        onStage: (s) => bar.set(s.total ? s.elapsed / s.total : null, ctx.t(`update.stage.${s.stage}`, { secs: s.elapsed ?? 0, version: s.version ?? '' })),
      });
      const msg = res.ok ? ctx.t('update.done', { version: res.version })
        : res.result ? ctx.t('update.refused', { code: res.result.code })
          : ctx.t(`update.stage.${res.reason?.code || 'timeout'}`, { version: res.version || '?' });
      put(out, h('p', { role: 'status' }, msg));
      ctx.notify(msg, { kind: res.ok ? 'info' : 'warning' });
      if (res.ok) redraw();
    } catch (err) {
      put(out, h('p', { class: 'err', role: 'alert' }, err.code === 'locked' ? lockedNote(ctx) : err.message));
    } finally { button.disabled = false; }
  }, { signal: ctx.signal });
  wrap.append(h('div', { class: 'row' }, button), out);
  return wrap;
}

function editForm(ctx, svc, device, redraw) {
  const name = h('input', { type: 'text', value: device.name, autocomplete: 'off' });
  const region = h('input', { type: 'text', value: device.region, autocomplete: 'off', maxlength: '8', class: 'short' });
  const notes = h('textarea', { rows: '3' });
  notes.value = device.notes || '';
  // W-16: whether the node is mesh only (no Wi-Fi, no MQTT); by default its version says
  const meshOnly = h('select', {},
    ['auto', 'yes', 'no'].map((v) => h('option', { value: v }, ctx.t(`node.meshOnly.${v}`, { guess: ctx.t(svc.rules.meshOnly(device.ver) ? 'node.meshOnly.yes' : 'node.meshOnly.no') }))));
  meshOnly.value = device.meshOnly === true ? 'yes' : device.meshOnly === false ? 'no' : 'auto';
  const out = h('p', { 'aria-live': 'polite' });
  const forget = h('button', { type: 'button', class: 'tool tool-danger' }, ctx.t('node.forget'));
  const form = h('form', { class: 'stack' },
    field(ctx.t('nodes.name'), name, ctx.t('node.nameHint')),
    field(ctx.t('nodes.region'), region, ctx.t('node.regionHint')),
    field(ctx.t('node.notes'), notes),
    field(ctx.t('node.meshOnlyLabel'), meshOnly, ctx.t('node.meshOnlyHint')),
    h('div', { class: 'row wrap' }, h('button', { type: 'submit', class: 'button' }, ctx.t('node.save')), forget), out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await svc.stores.devices.update(device.node, { name: name.value, region: region.value, notes: notes.value.trim(),
        meshOnly: { yes: true, no: false }[meshOnly.value] ?? null });
      out.textContent = ctx.t('node.saved');
      redraw();
    } catch (err) { out.textContent = err.message; }
  }, { signal: ctx.signal });
  forget.addEventListener('click', async () => {
    const ok = await confirm(ctx, {
      title: ctx.t('node.forgetTitle', { name: nameOf(device) }), lines: [ctx.t('node.forgetBody')],
      confirmLabel: ctx.t('node.forget'), danger: true,
    });
    if (!ok) return;
    await svc.stores.devices.remove(device.node);
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
    const top = h('div', {});
    const rest = h('div', {});
    let panel = null;
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
      const sets = await svc.stores.sets.list();
      const heard = lastHeard(device);
      const recent = events.slice(0, 8).map((e) => {
        const x = explainEvent(ctx, svc, e);
        return h('li', { class: `res res-${x.kind}` }, h('span', { class: 'res-name' }, when(ctx, e.at)), outcomeTag(ctx, x.kind),
          ...resLine(x, e.command), e.road === 'mesh' ? h('span', { class: 'res-help road-mark' }, ctx.t('road.overMesh')) : null);
      });
      if (!panel) {
        panel = sendPanel(ctx, svc, { devices: [device] }, { onDone: () => draw() });
        put(body, top, h('h2', {}, ctx.t('send.title')), panel, rest);
      }
      put(top, 
        h('p', { class: 'node-meta' },
          h('code', {}, device.key || device.node), ' · ', device.region, ' · ',
          heard ? [ctx.t('node.heard'), ' ', when(ctx, heard)] : ctx.t('nodes.heardUnknown'),
          Number.isFinite(device.fleet?.batteryMv) ? [' · ', `${(device.fleet.batteryMv / 1000).toFixed(2)} V`] : null),
        device.key ? null : h('p', { class: 'check check-caution' }, ctx.t('node.noWholeKey')));
      put(rest, 
        h('h2', {}, ctx.t('node.facts')),
        factList(ctx, svc, device, events),
        h('p', {}, h('a', { href: `#/stats/${device.node}` }, ctx.t('node.statsLink'))),
        h('h2', {}, ctx.t('update.title')),
        firmwareBlock(ctx, svc, device, release, page, draw),
        h('h2', {}, ctx.t('sets.title')),
        runSetPanel(ctx, svc, { devices: [device] }, sets),
        h('h2', {}, ctx.t('node.recent')),
        recent.length ? h('ul', { class: 'res-list' }, recent) : h('p', { class: 'muted' }, ctx.t('node.noHistory')),
        events.length > 8 ? h('p', {}, h('a', { href: `#/history/${device.node}` }, ctx.t('node.allHistory', { n: events.length }))) : null,
        h('details', { class: 'block' }, h('summary', {}, ctx.t('node.edit')), editForm(ctx, svc, device, draw)));
    }
    await draw();
  });
  return el;
}
