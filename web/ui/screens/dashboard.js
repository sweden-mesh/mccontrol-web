// The overview (W-18), the first screen. Blocks in the operator's order (plan §12.5): what needs
// attention, what came back since the last visit, the fleet in numbers, and the 24-hour traffic
// per node from Beacon -- a slot the statistics stream fills through provideTrafficBlock(); when
// nothing fills it, the block is left out.
//
// "Not heard on MQTT" is said as exactly that: a node may be on the air and only its MQTT link
// down. Battery and last-heard come from Beacon (read-only; asked again when older than an
// hour) and from the node's own answers.
import { h } from '../dom.js';
import { fleetCounts, needsAttention, recentSince } from '../../lib/jobs/overview.js';
import {
  explainEvent, nameOf, outcomeTag, screen, when, withServices, put, resultBody,
} from './node-kit.js';

export const route = '';
export const title = 'nav.home';

const FLEET_MAX_AGE = 3600000;

let traffic = null;
// fn(ctx, { devices, owner }) -> an element (or a promise of one), or null for nothing.
export function provideTrafficBlock(fn) { traffic = fn; }

const settings = (ctx) => {
  const p = ctx.prefs.current();
  return { hours: Number(p.notHeardHours) || 24, volts: Number(p.lowBatteryV) || 3.5 };
};

// One line per node, its reasons in the plan's order, each with its age where it has one.
function attentionBlock(ctx, items, s) {
  if (!items.length) return h('p', {}, ctx.t('dash.allWell', { hours: s.hours, volts: s.volts.toFixed(1) }));
  const byNode = new Map();
  for (const i of items) byNode.set(i.node, [...(byNode.get(i.node) || []), i]);
  return h('ul', { class: 'attention' }, [...byNode.values()].map((list) => h('li', {},
    h('a', { href: `#/node/${list[0].node}` }, list[0].name),
    h('ul', { class: 'reasons' }, list.map((i) => h('li', { class: `att-${i.kind}` },
      h('span', { class: 'reason' }, ctx.t(`dash.att.${i.kind}`, i.vars)),
      i.at ? [' ', h('span', { class: 'muted small' }, when(ctx, i.at))] : null))))));
}

function recentBlock(ctx, svc, events, names, since) {
  if (!events.length) {
    return h('p', { class: 'muted' }, since ? [ctx.t('dash.nothingSince'), ' ', when(ctx, since)] : ctx.t('dash.nothingYet'));
  }
  return [h('ul', { class: 'res-list' }, events.map((e) => {
    const x = explainEvent(ctx, svc, e);
    return h('li', { class: `res res-${x.kind}` },
      h('span', { class: 'res-name' }, h('a', { href: `#/node/${e.node}` }, names[e.node] || e.node)),
      outcomeTag(ctx, x.kind),
      h('span', { class: 'res-text' }, resultBody(x, e.command)[0]),
      h('span', { class: 'res-help' }, when(ctx, e.at)));
  })), h('p', {}, h('a', { href: '#/history' }, ctx.t('dash.allHistory')))];
}

function countsBlock(ctx, c, s) {
  const pair = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  return h('dl', { class: 'counts' },
    pair(ctx.t('dash.nodes'), String(c.total)),
    pair(ctx.t('dash.heard', { hours: s.hours }), String(c.heard)),
    pair(ctx.t('dash.quiet', { hours: s.hours }), String(c.quiet)),
    c.unknown ? pair(ctx.t('dash.unknown'), String(c.unknown)) : null,
    pair(ctx.t('dash.regions'), c.regions.map(([r, n]) => `${r} ${n}`).join(', ')),
    pair(ctx.t('dash.versions'), c.versions.map(([v, n]) => `${v || ctx.t('dash.verUnknown')} ${n}`).join(', ')),
    pair(ctx.t('dash.lastResults'), ['ok', 'refused', 'silent', 'forged']
      .filter((k) => c.results[k]).map((k) => `${ctx.t(`history.kind.${k}`)} ${c.results[k]}`).join(', ') || '–'));
}

export function render(ctx) {
  const body = h('div', {});
  const el = screen('dash', ctx.t('nav.home'), body);
  withServices(ctx, body, async (svc, gate) => {
    const since = await svc.stores.meta.get('lastVisit');
    await svc.stores.meta.set('lastVisit', new Date().toISOString());
    let release = null;
    let fleetAsked = false;

    async function draw() {
      const devices = await svc.stores.devices.list();
      if (!devices.length) {
        put(body, 
          h('p', {}, ctx.t('dash.empty')),
          h('ul', { class: 'plain' },
            h('li', {}, h('a', { href: '#/setup' }, ctx.t('dash.toSetup'))),
            h('li', {}, h('a', { href: '#/nodes' }, ctx.t('dash.toDiscover')))));
        return;
      }
      const s = settings(ctx);
      const now = Date.now();
      const names = Object.fromEntries(devices.map((d) => [d.node, nameOf(d)]));
      const items = needsAttention(devices, { now, hours: s.hours, thresholdMv: s.volts * 1000, release, rules: svc.rules });
      const recent = recentSince(await svc.stores.history.list({ limit: 200 }), since, 12);
      const counts = fleetCounts(devices, { now, hours: s.hours, rules: svc.rules });
      const slot = h('div', {});
      put(body, 
        h('section', { 'aria-labelledby': 'dash-att' }, h('h2', { id: 'dash-att' }, ctx.t('dash.attention', { n: new Set(items.map((i) => i.node)).size })), attentionBlock(ctx, items, s)),
        h('section', { 'aria-labelledby': 'dash-recent' }, h('h2', { id: 'dash-recent' }, ctx.t('dash.recent')), recentBlock(ctx, svc, recent, names, since)),
        h('section', { 'aria-labelledby': 'dash-fleet' }, h('h2', { id: 'dash-fleet' }, ctx.t('dash.fleet')), countsBlock(ctx, counts, s),
          h('p', { class: 'row wrap' }, h('a', { href: '#/nodes', class: 'tool' }, ctx.t('dash.toNodes')), h('a', { href: '#/send', class: 'tool' }, ctx.t('dash.toSend')))),
        slot);
      if (traffic) {
        Promise.resolve(traffic(ctx, { devices, owner: gate.owner }))
          .then((block) => { if (block && !ctx.signal.aborted) put(slot, block); })
          .catch(() => { /* the statistics block failing leaves the slot empty */ });
      }
      // Battery and last heard from Beacon when older than an hour: a read, nothing transmitted.
      const stale = devices.some((d) => !d.fleet?.fetched || now - Date.parse(d.fleet.fetched) > FLEET_MAX_AGE);
      if (stale && !fleetAsked) {
        fleetAsked = true;
        svc.fleet().then(() => { if (!ctx.signal.aborted) draw(); }).catch(() => {});
      }
    }
    await draw();
    svc.releases().then((r) => { release = r; if (r && !ctx.signal.aborted) draw(); }).catch(() => {});
  });
  return el;
}
