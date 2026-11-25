// My nodes (W-7): every node set up with this key, as a table on a wide screen and as cards on
// a phone (the same <table>, restyled under ~700 px by a container query). Search is the first
// control under the heading; a group narrows the list. Nodes are added by discovery (the alive
// messages of lou-20 and later, opened with this key wherever the node is: nothing is sent and no
// region is chosen, IATA-2) or by pasting a whole key. Each row says whether the node is online
// (its alive opens), offline (its will cleared it) or no longer yours (it opens with another key).
import { h } from '../dom.js';
import { dataChanged } from '../tiles/sources.js';   // the page's lists follow a node added, renamed or forgotten here
import { lowBatteryVolts, notHeardHours } from './settings-store.js';
import { brokerText } from './key-register.js';
import { batteryKnown, lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { updateAvailable } from '../../lib/jobs/releases.js';
import {
  byName, explainEvent, field, nameOf, outcomeTag, progressLine, screen, volts, when, withServices, put, lockedNote } from './node-kit.js';

export const route = 'nodes';
export const title = 'nav.nodes';

const HOURS = () => notHeardHours();

function heardCell(ctx, d, now) {
  const at = lastHeard(d);
  if (at === null) return h('span', { class: 'muted' }, ctx.t('nodes.heardUnknown'));
  const quiet = now - at > HOURS(ctx) * 3600000;
  return h('span', { class: quiet ? 'warn-text' : '' }, quiet ? `${ctx.t('nodes.quiet')} ` : '', when(ctx, at));
}

function batteryCell(ctx, d) {
  const mv = d.fleet?.batteryMv;
  if (!batteryKnown(mv)) return h('span', { class: 'muted' }, volts(ctx.t, mv));
  const low = mv < lowBatteryVolts() * 1000;
  return h('span', { class: low ? 'warn-text' : '' }, volts(ctx.t, mv), low ? ` ${ctx.t('nodes.low')}` : '');
}

function versionCell(ctx, svc, d, release) {
  if (!d.ver) return h('span', { class: 'muted' }, ctx.t('nodes.verUnknown'));
  const up = updateAvailable(svc.rules, d.ver, release);
  return h('span', {}, h('code', { title: d.ver }, shortVersion(svc.rules, d.ver)),
    up ? h('span', { class: 'tag tag-update' }, ctx.t('update.available')) : null);
}

// online / offline / not yours, from the node's alive (lou-20 and later); a dash before that.
export function stateCell(ctx, d) {
  const state = d.alive?.state;
  if (!state) return h('span', { class: 'muted' }, '–');
  return h('span', { class: state === 'online' ? '' : 'warn-text' }, ctx.t(`alive.${state}`));
}

function resultCell(ctx, svc, d) {
  if (!d.lastResult) return h('span', { class: 'muted' }, '–');
  const x = explainEvent(ctx, svc, { ...d.lastResult, node: d.node, note: '' });
  return h('span', {}, outcomeTag(ctx, x.kind), ' ', h('code', {}, d.lastResult.command));
}

// The table: header row, one row per node; each data cell also carries its label for the card
// layout (hidden in the table layout, shown in the cards).
function table(ctx, svc, devices, release) {
  const now = Date.now();
  const cols = ['nodes.colState', 'nodes.colHeard', 'nodes.colVersion', 'nodes.colBattery', 'nodes.colResult'];
  const cell = (key, content) => h('td', {}, h('span', { class: 'cell-label', 'aria-hidden': 'true' }, ctx.t(key)), content);
  return h('div', { class: 'table-wrap', role: 'region', 'aria-labelledby': 'nodes-caption', tabindex: '0' },
    h('table', { class: 'nodes-table' },
      h('caption', { id: 'nodes-caption', class: 'visually-hidden' }, ctx.t('nodes.caption', { n: devices.length })),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, ctx.t('nodes.colName')), cols.map((c) => h('th', { scope: 'col' }, ctx.t(c))))),
      h('tbody', {}, devices.map((d) => h('tr', {},
        h('th', { scope: 'row' }, h('a', { href: `#/node/${d.node}` }, nameOf(d)),
          d.name ? h('code', { class: 'node-id' }, d.node) : null),
        cell(cols[0], stateCell(ctx, d)),
        cell(cols[1], heardCell(ctx, d, now)),
        cell(cols[2], versionCell(ctx, svc, d, release)),
        cell(cols[3], batteryCell(ctx, d)),
        cell(cols[4], resultCell(ctx, svc, d)))))));
}

// "Find my nodes": the alive scan, as discovery does it by itself; nothing is sent.
function discoverForm(ctx, svc, redraw) {
  const button = h('button', { type: 'submit', class: 'button' }, ctx.t('nodes.discoverButton'));
  const out = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'stack' }, h('p', { class: 'muted' }, ctx.t('nodes.discoverExplain')),
    h('div', { class: 'row' }, button), out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    const bar = progressLine();
    put(out, bar.el);
    try {
      const found = await svc.jobs.discoverAlive({
        signal: ctx.signal,
        onProgress: (s) => bar.set(s.total ? s.elapsed / s.total : null, ctx.t('nodes.discoverWait', { n: s.answered, secs: Math.ceil(s.total - s.elapsed) })),
      });
      redraw();
      if (!found.length) { put(out, h('p', {}, ctx.t('nodes.discoverNone'))); return; }
      put(out, h('ul', { class: 'found' }, found.map((f) => {
        const name = h('input', { type: 'text', value: f.name || '', autocomplete: 'off', class: 'short' });
        const add = h('button', { type: 'button', class: 'tool' }, ctx.t('nodes.adopt'));
        add.addEventListener('click', async () => {
          try {
            await svc.jobs.adopt({ node: f.key, key: f.key, region: '', alive: f.alive }, name.value);
            add.replaceWith(h('span', {}, ctx.t('nodes.adopted')));
            redraw();
            dataChanged('devices');
          } catch (err) { ctx.notify(err.message, { kind: 'error' }); }
        });
        return h('li', {}, h('code', {}, f.node), ' ', h('span', {}, ctx.t(`alive.${f.state}`)), ' ',
          f.knownAs ? h('span', {}, ctx.t('nodes.knownAs', { name: f.knownAs }))
            : f.state === 'online' ? [field(ctx.t('nodes.nameFor', { node: f.node }), name), add] : null);
      })));
    } catch (err) {
      put(out, h('p', { class: 'err', role: 'alert' }, err.code === 'locked' ? lockedNote(ctx) : brokerText(ctx.t, err.message)));
    } finally { button.disabled = false; }
  }, { signal: ctx.signal });
  return form;
}

function addForm(ctx, svc, redraw) {
  const key = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', class: 'mono' });
  const name = h('input', { type: 'text', autocomplete: 'off' });
  const out = h('p', { 'aria-live': 'polite' });
  const form = h('form', { class: 'stack' },
    field(ctx.t('nodes.key'), key, ctx.t('nodes.keyHint')),
    field(ctx.t('nodes.name'), name), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'button' }, ctx.t('nodes.add'))), out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const k = key.value.replace(/\s+/g, '').toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(k)) throw new Error(ctx.t('nodes.wholeKey'));
      await svc.stores.devices.add({ node: k, key: k, region: '', name: name.value });
      out.textContent = ctx.t('nodes.added');
      form.reset();
      redraw();
      dataChanged('devices');
    } catch (err) { out.textContent = err.message; }
  }, { signal: ctx.signal });
  return form;
}

export function render(ctx) {
  const body = h('div', {});
  const el = screen('nodes', ctx.t('nav.nodes'), body);
  withServices(ctx, body, async (svc) => {
    const search = h('input', { type: 'search', autocomplete: 'off', enterkeyhint: 'search', class: 'search' });
    const groupFilter = h('select', {});
    const groupField = field(ctx.t('nodes.group'), groupFilter);
    const listSlot = h('div', {});
    const tools = h('div', { class: 'row wrap' });
    let release = null;

    async function draw() {
      const all = (await svc.stores.devices.list()).sort(byName(ctx.lang));
      const groups = await svc.stores.groups.list();
      const chosen = groupFilter.value;
      put(groupFilter, h('option', { value: '' }, ctx.t('nodes.allGroups')),
        groups.map((g) => h('option', { value: g.id, selected: g.id === chosen }, `${g.id} (${g.members.length})`)));
      groupField.hidden = !groups.length;
      const q = search.value.trim().toLowerCase();
      const g = groups.find((x) => x.id === groupFilter.value);
      const shown = all.filter((d) => (!g || g.members.includes(d.node))
        && (!q || [d.name, d.node, d.ver, d.notes].some((v) => String(v || '').toLowerCase().includes(q))));
      if (!all.length) {
        put(listSlot, h('p', {}, ctx.t('nodes.empty')));
      } else if (!shown.length) {
        put(listSlot, h('p', { role: 'status' }, ctx.t('nodes.noMatch')));
      } else {
        put(listSlot, 
          h('p', { class: 'muted small', role: 'status' }, ctx.t('nodes.count', { n: shown.length, of: all.length })),
          table(ctx, svc, shown, release));
      }
      put(tools, ...toolButtons(all));
    }

    function toolButtons(all) {
      if (!all.length) return [];
      const versions = h('button', { type: 'button', class: 'tool' }, ctx.t('nodes.refreshVersions'));
      const fleet = h('button', { type: 'button', class: 'tool' }, ctx.t('nodes.refreshFleet'));
      const status = h('span', { class: 'muted small', 'aria-live': 'polite' });
      versions.addEventListener('click', async () => {
        versions.disabled = true;
        try {
          const r = await svc.jobs.refresh({
            nodes: all.map((d) => d.node), signal: ctx.signal,
            onProgress: (s) => { status.textContent = ctx.t('nodes.refreshing', { name: s.name, i: (s.index ?? 0) + 1, of: s.count ?? all.length }); },
          });
          ctx.notify(ctx.t('nodes.refreshed', { versions: r.versioned, named: r.named, of: all.length }));
          await draw();
        } catch (err) {
          ctx.notify(err.code === 'locked' ? ctx.t('send.locked') : err.message, { kind: 'error' });
        }
        finally { versions.disabled = false; status.textContent = ''; }
      });
      fleet.addEventListener('click', async () => {
        fleet.disabled = true;
        status.textContent = ctx.t('nodes.asking');
        try {
          const r = await svc.fleet();
          ctx.notify(ctx.t('nodes.fleetDone', { n: r.updated, failed: r.failed }));
          await draw();
        } catch (err) { ctx.notify(err.message, { kind: 'error' }); }
        finally { fleet.disabled = false; status.textContent = ''; }
      });
      return [versions, h('span', { class: 'muted small' }, ctx.t('nodes.versionsCost', { n: all.length * 2 })), fleet, status];
    }

    search.addEventListener('input', draw, { signal: ctx.signal });
    groupFilter.addEventListener('change', draw, { signal: ctx.signal });
    put(body, 
      h('div', { class: 'filters' }, field(ctx.t('nodes.search'), search), groupField),
      listSlot,
      tools,
      h('h2', {}, ctx.t('nodes.addTitle')),
      h('details', { class: 'block' }, h('summary', {}, ctx.t('nodes.discoverTitle')), discoverForm(ctx, svc, draw)),
      h('details', { class: 'block' }, h('summary', {}, ctx.t('nodes.addByKey')), addForm(ctx, svc, draw)));
    await draw();
    svc.releases().then((r) => { release = r; if (r && !ctx.signal.aborted) draw(); });
  });
  return el;
}
