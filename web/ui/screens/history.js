// History (W-9): everything sent with this key and what came back, newest first, kept in this
// browser. Filter by node and by result; export as CSV or JSON; import a JSON export (from
// another browser, or a backup) -- events already here are skipped, never overwritten.
// #/history/<node> opens it filtered to that node. An event sent over the mesh (W-16) says so.
import { h } from '../dom.js';
import { areaName } from '../../lib/discovery/areas.js';
import { resultKind } from '../../lib/store/index.js';
import {
  byName, download, explainEvent, field, nameOf, outcomeTag, screen, when, withServices, put, resultBody,
} from './node-kit.js';

export const route = 'history';
export const title = 'nav.history';

const PAGE = 100;
const KINDS = ['ok', 'refused', 'silent', 'forged', 'summary'];

// One CSV cell: quoted, quotes doubled, and a leading = + - @ made inert for spreadsheets.
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export const CSV_COLUMNS = ['id', 'at', 'node', 'name', 'region', 'command', 'result', 'code', 'codeName', 'verified', 'reply', 'note', 'batch', 'road', 'relay', 'route', 'relayStatus', 'snr'];

export function toCsv(events, names = {}) {
  const rows = events.map((e) => CSV_COLUMNS.map((c) => {
    if (c === 'name') return csvCell(names[e.node] || '');
    if (c === 'result') return csvCell(resultKind(e));
    if (c === 'road') return csvCell(e.road || 'mqtt');          // before the mesh road, every event went over MQTT
    if (c === 'relay') return csvCell(e.relay?.node ?? '');
    if (c === 'route') return csvCell(e.relay?.route ?? '');
    if (c === 'relayStatus') return csvCell(e.relay?.status ?? '');
    if (c === 'snr') return csvCell(e.relay?.snr ?? '');
    return csvCell(e[c]);
  }).join(','));
  return `${CSV_COLUMNS.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

// "through Gisebo, flooded, 5.5 dB": which relay, the route asked for, and how well it heard the answer.
export function relayMark(ctx, e, names = {}) {
  const r = e.relay || {};
  return ctx.t('road.overRelay', { relay: names[r.node] || r.node || '?', route: r.route ? ctx.t(`road.routeShort.${r.route}`) : '?' })
    + (Number.isFinite(r.snr) ? `, ${r.snr} dB` : '');
}

export function render(ctx) {
  const body = h('div', {});
  const el = screen('history', ctx.t('nav.history'), body);
  withServices(ctx, body, async (svc, gate) => {
    const devices = (await svc.stores.devices.list()).sort(byName(ctx.lang));
    const names = Object.fromEntries(devices.map((d) => [d.node, nameOf(d)]));
    const nodeSel = h('select', {},
      h('option', { value: '' }, ctx.t('history.allNodes')),
      h('option', { value: 'all' }, ctx.t('history.broadcasts')),
      devices.map((d) => h('option', { value: d.node }, nameOf(d))));
    nodeSel.value = String(ctx.args[0] || '').toUpperCase();
    if (!nodeSel.value) nodeSel.value = '';
    const kindSel = h('select', {}, h('option', { value: '' }, ctx.t('history.allResults')),
      KINDS.map((k) => h('option', { value: k }, ctx.t(`history.kind.${k}`))));
    const listSlot = h('div', {});
    let shown = PAGE;

    const filters = () => ({ node: nodeSel.value || null, result: kindSel.value || null });
    async function draw() {
      const events = await svc.stores.history.list(filters());
      if (!events.length) { put(listSlot, h('p', { role: 'status' }, ctx.t('history.empty'))); return; }
      const rows = events.slice(0, shown).map((e) => {
        const x = explainEvent(ctx, svc, e);
        return h('tr', {},
          h('td', {}, when(ctx, e.at)),
          h('th', { scope: 'row' }, e.node ? h('a', { href: `#/node/${e.node}` }, names[e.node] || e.node) : ctx.t('history.region', { region: areaName(svc.data.areas, e.region) })),
          h('td', {}, h('code', {}, e.command)),
          h('td', {}, outcomeTag(ctx, x.kind), e.road === 'mesh' ? [' ', h('span', { class: 'road-mark' }, ctx.t('road.overMesh'))] : null,
            e.road === 'relay' ? [' ', h('span', { class: 'road-mark' }, relayMark(ctx, e, names))] : null),
          h('td', { class: 'res-cell' }, x.kind === 'summary' ? x.text : resultBody(x)[0],
            x.kind === 'refused' ? h('span', { class: 'res-help' }, x.help) : null));
      });
      const more = events.length > shown ? h('button', { type: 'button', class: 'tool' }, ctx.t('history.more', { n: events.length - shown })) : null;
      more?.addEventListener('click', () => { shown += PAGE; draw(); });
      put(listSlot, 
        h('p', { class: 'muted small', role: 'status' }, ctx.t('history.count', { n: Math.min(shown, events.length), of: events.length })),
        h('div', { class: 'table-wrap', role: 'region', 'aria-labelledby': 'history-caption', tabindex: '0' },
          h('table', { class: 'history-table' },
            h('caption', { id: 'history-caption', class: 'visually-hidden' }, ctx.t('history.caption')),
            h('thead', {}, h('tr', {}, ['history.colWhen', 'history.colNode', 'history.colCommand', 'history.colResult', 'history.colReply']
              .map((k) => h('th', { scope: 'col' }, ctx.t(k))))),
            h('tbody', {}, rows))),
        more);
    }

    const stamp = () => new Date().toISOString().slice(0, 10);
    const short = gate.owner.slice(0, 8);
    const csv = h('button', { type: 'button', class: 'tool' }, ctx.t('history.exportCsv'));
    const json = h('button', { type: 'button', class: 'tool' }, ctx.t('history.exportJson'));
    csv.addEventListener('click', async () => {
      download(`mccontrol-history-${short}-${stamp()}.csv`, toCsv(await svc.stores.history.list(filters()), names), 'text/csv');
    }, { signal: ctx.signal });
    json.addEventListener('click', async () => {
      const events = await svc.stores.history.list(filters());
      download(`mccontrol-history-${short}-${stamp()}.json`,
        `${JSON.stringify({ format: 'mccontrol-history', v: 1, owner: svc.stores.owner, exported: new Date().toISOString(), events }, null, 1)}\n`,
        'application/json');
    }, { signal: ctx.signal });
    const file = h('input', { type: 'file', accept: 'application/json,.json' });
    const importOut = h('p', { 'aria-live': 'polite' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const parsed = JSON.parse(await f.text());
        const r = await svc.stores.history.import(Array.isArray(parsed) ? parsed : parsed.events);
        importOut.textContent = ctx.t('history.imported', r);
        draw();
      } catch (err) {
        importOut.textContent = ctx.t('history.importFailed', { reason: err.message });
      }
      file.value = '';
    }, { signal: ctx.signal });

    nodeSel.addEventListener('change', () => { shown = PAGE; draw(); }, { signal: ctx.signal });
    kindSel.addEventListener('change', () => { shown = PAGE; draw(); }, { signal: ctx.signal });
    put(body, 
      h('div', { class: 'filters' }, field(ctx.t('history.node'), nodeSel), field(ctx.t('history.result'), kindSel)),
      listSlot,
      h('h2', {}, ctx.t('history.keep')),
      h('p', { class: 'muted' }, ctx.t('history.keepExplain')),
      h('div', { class: 'row wrap' }, csv, json),
      field(ctx.t('history.import'), file, ctx.t('history.importHint')),
      importOut);
    await draw();
  });
  return el;
}
