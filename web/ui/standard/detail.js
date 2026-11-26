// The standard layout's right side (W-29a): the selected node, its top panel (name, what it is,
// tabs) and one tab at a time. Overview is four panels edge to edge, sharing 1 px borders and
// touching the list and the top panel (no gaps, no padding between them): Status, Location,
// Send a command and Recent results. The other tabs reuse the screens the retro board opens as
// modals, so both layouts do the same jobs the same way (no Commands tab, W-35d: sending is
// Overview's "Send a command", what came back is History):
//   History   the history screen for this node (screens/history.js)
//   Firmware  the version, the update and what is known (screens/node.js)
//   Settings  name, region, notes, forget, and Set/update region (screens/node.js)
// With no node selected it is the overview: the owner's nodes on the map, framed on them.
import { h } from '../dom.js';
import { lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { updateAvailable } from '../../lib/jobs/releases.js';
import { lowBatteryVolts, notHeardHours } from '../screens/settings-store.js';
import { explainEvent, nameOf, volts } from '../screens/node-kit.js';
import * as historyScreen from '../screens/history.js';
import { canUpdate, editForm, factList, firmwareBlock, nodeFacts, REGION_SET, runUpdate } from '../screens/node.js';
import { runSetPanel } from '../screens/sets.js';
import { commandLine } from '../tiles/node-view.js';
import { tookText, age, clockTime, stateMark } from '../tiles/kit.js';
import { mapModel, nodeRegions, nodeStatus } from '../tiles/data.js';
import { areaNodes } from '../tiles/map.js';
import { dataChanged, jobs, onDataChanged, onJobs } from '../tiles/sources.js';
import { mapView } from './map.js';
import { parseNeighbors } from './neighbours-data.js';

export const TABS = Object.freeze(['overview', 'history', 'firmware', 'settings']);

const statusOpts = (svc, release = null) => ({ now: Date.now(), hours: notHeardHours(), thresholdMv: lowBatteryVolts() * 1000, release, rules: svc.rules });

// "12 d 4 h", "3 h 10 min".
export function uptimeText(ctx, secs) {
  if (!Number.isFinite(secs) || secs <= 0) return '–';
  const d = Math.floor(secs / 86400); const hrs = Math.floor((secs % 86400) / 3600); const min = Math.floor((secs % 3600) / 60);
  return d ? ctx.t('std.uptimeD', { d, h: hrs }) : ctx.t('std.uptimeH', { h: hrs, min });
}

// The owner's nodes and the area around them, for a map: { mine, others, links }.
async function mapData(svc, devices, statusOf) {
  const regions = nodeRegions(devices);   // every IATA the owner's nodes are in (W-33g)
  let rows = [];
  for (const r of regions) { try { rows = rows.concat(await areaNodes(r)); } catch { /* Beacon down: the owner's own positions only */ } }
  const model = mapModel(devices, rows);
  const mine = model.mine.map((m) => ({
    node: m.device.node, name: nameOf(m.device), state: statusOf(m.device),
    lat: m.node?.lat ?? m.device.fleet?.lat, lng: m.node?.lng ?? m.device.fleet?.lng, row: m.node,
  }));
  return { model, mine };
}

// A panel of the Overview: a heading and its body, nothing around it.
const panel = (cls, title, ...body) => h('section', { class: `std-panel ${cls}`, 'aria-label': title }, h('h2', {}, title), ...body);

function tabCtx(ctx, nodeId, signal) {
  return Object.freeze({ ...ctx, route: 'nodeinfo', args: [nodeId], signal, close: () => {} });
}

// No node selected: the owner's nodes on the map (W-29d: the overview map frames them).
export function overviewAll(ctx, svc, { onPick }) {
  const el = h('div', { class: 'std-detail' });
  (async () => {
    const devices = await svc.stores.devices.list();
    const opts = statusOpts(svc);
    const { mine, model } = await mapData(svc, devices, (d) => nodeStatus(d, opts).state);
    if (ctx.signal.aborted) return;
    el.replaceChildren(
      h('div', { class: 'std-top' }, h('h1', {}, ctx.t('std.yourNodes')),
        h('p', { class: 'muted std-meta' }, devices.length ? ctx.t('std.pickNode', { n: devices.length }) : ctx.t('std.noNodes'))),
      h('div', { class: 'std-panels std-panels-one' },
        panel('std-p-map', ctx.t('std.location'), mapView(ctx, { mine, others: model.others, links: model.links.map(([a, b]) => [a, b]), onPick, label: ctx.t('std.mapAll') }))));
  })().catch((e) => el.replaceChildren(h('p', { class: 'tile-err' }, e.message)));
  return el;
}

export function nodeDetail(ctx, svc, nodeId, { tab = 'overview', onTab, onPick }) {
  const el = h('div', { class: 'std-detail' });
  let leave = null;   // the tab's own signal

  async function draw() {
    leave?.abort();
    leave = new AbortController();
    ctx.signal.addEventListener('abort', () => leave.abort(), { once: true });
    const signal = leave.signal;
    const device = await svc.stores.devices.get(nodeId);
    if (ctx.signal.aborted || signal.aborted) return;
    if (!device) { el.replaceChildren(h('p', { class: 'std-empty muted' }, ctx.t('node.missing'))); return; }
    const release = await svc.releases().catch(() => null);
    if (signal.aborted) return;
    const st = nodeStatus(device, statusOpts(svc, release));
    const heard = lastHeard(device);
    const tabs = h('div', { class: 'std-tabs', role: 'tablist', 'aria-label': ctx.t('std.nodeTabs') });
    const body = h('div', { class: 'std-tabpanel', role: 'tabpanel', id: `std-tab-${nodeId}`, tabindex: '-1' });
    for (const name of TABS) {
      const b = h('button', { type: 'button', role: 'tab', class: 'std-tab', id: `std-tab-${name}`, 'aria-selected': String(name === tab),
        'aria-controls': body.id, tabindex: name === tab ? '0' : '-1' }, ctx.t(`std.tab.${name}`));
      b.addEventListener('click', () => onTab(name));
      tabs.append(b);
    }
    body.setAttribute('aria-labelledby', `std-tab-${tab}`);
    tabs.addEventListener('keydown', (e) => {
      const i = TABS.indexOf(tab);
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      onTab(TABS[(to + TABS.length) % TABS.length], { focus: true });
    }, { signal });
    const kind = device.fleet?.nodeTypeName || ctx.t('std.repeater');
    el.replaceChildren(
      h('div', { class: 'std-top' },
        h('h1', {}, nameOf(device)),
        h('p', { class: 'muted std-meta' }, [kind, device.ver ? shortVersion(svc.rules, device.ver) : ctx.t('nodes.verUnknown'), ...nodeFacts(ctx, device),
          heard ? h('span', {}, ctx.t('tile.heard'), ' ', age(ctx, heard)) : ctx.t('nodes.heardUnknown')]
          .filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))),
        tabs),
      body);
    const tctx = tabCtx(ctx, nodeId, signal);
    if (tab === 'overview') body.append(overview(tctx, svc, device, st, release, onPick, onTab));
    else if (tab === 'history') body.append(h('div', { class: 'std-pad std-screen' }, historyScreen.render(tctx)));
    else if (tab === 'firmware') {
      const events = await svc.stores.history.list({ node: device.node });
      const page = await svc.releasePage().catch(() => null);
      if (signal.aborted) return;
      body.append(h('div', { class: 'std-pad std-screen' },
        h('h2', {}, ctx.t('update.title')), firmwareBlock(tctx, svc, device, release, page, draw),
        h('h2', {}, ctx.t('node.facts')), factList(tctx, svc, device, events)));
    } else if (tab === 'settings') {
      const steps = svc.data.brokers.default_sets?.[REGION_SET] || null;
      body.append(h('div', { class: 'std-pad std-screen' },
        h('h2', {}, ctx.t('node.edit')), editForm(tctx, svc, device, draw),
        steps ? [h('h2', {}, ctx.t('node.regionSet')), runSetPanel(tctx, svc, { devices: [device] }, { [REGION_SET]: steps },
          { only: true, argLabel: ctx.t('node.regionSetArg'), argHint: ctx.t('node.regionSetHint') })] : null));
    }
  }

  el.focusTab = () => el.querySelector('.std-tab[aria-selected="true"]')?.focus();
  draw().catch((e) => el.replaceChildren(h('p', { class: 'tile-err' }, e.message)));
  ctx.signal.addEventListener('abort', onDataChanged((what) => { if (tab === 'overview' && what !== 'seen') draw().catch(() => {}); }), { once: true });
  el.ready = () => draw();
  return el;
}

function overview(ctx, svc, device, st, release, onPick, onTab) {
  // Status
  const why = st.reasons.map((r) => ctx.t(`dash.att.${r.kind}`, r.vars)).join('; ');
  // Never heard, and the last command got no answer: say so beside the mark, not just "not known".
  const silent = st.state === 'unknown' && st.unanswered != null ? ctx.t('hint.noAnswerYet', { command: st.unanswered }) : '';
  const up = device.ver ? updateAvailable(svc.rules, device.ver, release) : null;
  const events = svc.stores.history.list({ node: device.node, limit: 60 });
  const nb = h('button', { type: 'button', class: 'link-button std-nb' }, ctx.t('std.neighbours'));
  nb.addEventListener('click', () => ctx.navigate(`#neighbours/${device.node}`), { signal: ctx.signal });
  const nbValue = h('dd', {}, '–');
  const stats = h('button', { type: 'button', class: 'tool std-small' }, ctx.t('tile.stats'));
  stats.addEventListener('click', () => ctx.navigate(`#stats/${device.node}`), { signal: ctx.signal });
  const fleet = device.fleet || {};
  // "Update now" beside "update available", when this node can take the update over the control
  // plane: it asks the node first (`ota check`) and updates only when the node says one fits.
  const updateOut = h('div', { class: 'std-update-out', 'aria-live': 'polite' });
  const updateNow = up && canUpdate(svc, device, release)
    ? h('button', { type: 'button', class: 'link-button std-update-now' }, h('span', { 'aria-hidden': 'true' }, '↗ '), ctx.t('update.now')) : null;
  // An update is out but this node cannot take it over remote control (its firmware does not
  // admit `ota update` there, or it has no Wi-Fi): say so, and lead to the Firmware tab's reason.
  const byHand = up && !updateNow ? h('button', { type: 'button', class: 'link-button std-update-how' }, ctx.t('update.byHandShort')) : null;
  byHand?.addEventListener('click', () => onTab('firmware'), { signal: ctx.signal });
  updateNow?.addEventListener('click', () => runUpdate(ctx, svc, device, release, { out: updateOut, control: updateNow, redraw: () => dataChanged('devices') }), { signal: ctx.signal });
  // "No longer yours": its alive message stopped opening with this key. Say what that usually
  // means and offer to read the alive messages again (nothing is sent to the node).
  let notYours = null;
  if (device.alive?.state === 'not-yours') {
    const again = h('button', { type: 'button', class: 'tool std-small' }, ctx.t('alive.checkAgain'));
    const said = h('span', { class: 'muted', role: 'status' });
    again.addEventListener('click', async () => {
      again.disabled = true;
      said.textContent = ctx.t('alive.checking');
      try {
        await svc.jobs.discoverAlive({ signal: ctx.signal });
        const fresh = await svc.stores.devices.get(device.node);
        if (fresh?.alive?.state === 'not-yours') { said.textContent = ctx.t('alive.stillNotYours'); again.disabled = false; } else dataChanged('devices');
      } catch (e) { said.textContent = e.code === 'locked' ? ctx.t('send.locked') : e.message; again.disabled = false; }
    }, { signal: ctx.signal });
    notYours = h('p', { class: 'std-not-yours' }, ctx.t('alive.notYoursWhy'), ' ', again, ' ', said);
  }
  const statusPanel = panel('std-p-status', ctx.t('std.status'),
    h('p', { class: 'std-state' }, stateMark(ctx, st.state, why || silent || ctx.t(`tile.state.${st.state}`))),
    notYours,
    h('dl', { class: 'std-dl' },
      h('dt', {}, ctx.t('std.firmware')), h('dd', {}, h('code', {}, device.ver ? shortVersion(svc.rules, device.ver) : '–'),
        up ? [' ', h('span', { class: 'std-tag' }, ctx.t('update.available')), ...(updateNow ? [' ', updateNow] : byHand ? [' ', byHand] : [])] : up === false ? [' ', h('span', { class: 'muted' }, ctx.t('std.upToDate'))] : null),
      h('dt', {}, ctx.t('std.battery')), h('dd', {}, volts(ctx.t, fleet.batteryMv)),
      h('dt', {}, ctx.t('std.uptime')), h('dd', {}, uptimeText(ctx, fleet.uptimeSecs)),
      h('dt', {}, nb), nbValue),
    updateOut,
    h('p', { class: 'std-actions' }, stats));
  events.then((list) => {
    const last = list.find((e) => e.command === 'neighbors' && e.code === 0 && e.reply);
    const parsed = last ? parseNeighbors(last.reply) : [];
    const n = parsed.length || fleet.neighbours || 0;
    const best = parsed.length ? Math.max(...parsed.map((p) => p.snr)) : null;
    nbValue.textContent = n ? (best === null ? String(n) : ctx.t('std.nbBest', { n, snr: best.toFixed(1) })) : '–';
  }).catch(() => {});

  // Location: the node and its neighbours.
  const mapSlot = h('div', { class: 'std-map-slot' });
  (async () => {
    const devices = await svc.stores.devices.list();
    const opts = statusOpts(svc, release);
    const { mine, model } = await mapData(svc, devices, (d) => nodeStatus(d, opts).state);
    if (ctx.signal.aborted) return;
    const me = mine.find((m) => m.node === device.node);
    // A link between two of the owner's nodes is kept once, either way round: the other end.
    const myLinks = me?.row ? model.links.filter(([a, b]) => a.id === me.row.id || b.id === me.row.id)
      .map(([a, b]) => (a.id === me.row.id ? [a, b] : [b, a])) : [];
    const neighbourIds = new Set(myLinks.map(([, b]) => b.id));
    const ownNeighbours = mine.filter((m) => m.row && neighbourIds.has(m.row.id));
    const frame = me && Number.isFinite(me.lat) ? [me, ...myLinks.map(([, b]) => b)] : null;
    // A node without a known position: not an empty panel, but the map greyed, framed by every
    // position that is known (the owner's other nodes), with a line saying so.
    const placed = mine.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
    if (!frame && placed.length) {
      mapSlot.replaceChildren(mapView(ctx, {
        mine: placed, others: model.others, links: model.links.map(([a, b]) => [a, b]), onPick, frame: placed,
        label: ctx.t('std.mapAll'), note: ctx.t('std.mapNoPosition', { name: nameOf(device) }),
      }));
      return;
    }
    mapSlot.replaceChildren(mapView(ctx, {
      mine: [me, ...ownNeighbours].filter(Boolean), others: myLinks.map(([, b]) => b).filter((b) => !ownNeighbours.some((m) => m.row?.id === b.id)),
      links: myLinks, selected: device.node, onPick, frame: frame || [], label: ctx.t('std.mapNode', { name: nameOf(device) }),
    }));
  })().catch((e) => mapSlot.replaceChildren(h('p', { class: 'muted' }, e.message)));

  // Send a command: the retro NODE tile's command line, the same checks and road.
  const line = commandLine(ctx, svc, device.node);
  line.use(device);

  // Recent results
  const table = h('tbody', {});
  const all = h('button', { type: 'button', class: 'tool std-small' }, ctx.t('std.allHistory'));
  all.addEventListener('click', () => onTab('history'), { signal: ctx.signal });
  // A command on its way is a row at once, "pending" with what it waits for, until its answer
  // (or "no answer") takes its place: through a relay or the mesh that is up to two minutes.
  let answered = null;          // the history rows, once read
  const pendingRows = () => jobs().filter((j) => j.nodes?.includes(device.node)).map((j) => h('tr', { class: 'std-pending' },
    h('td', { class: 'muted std-time' }, clockTime(ctx, new Date(j.at).toISOString())),
    h('td', { class: 'muted std-took' }, tookText(ctx, Date.now() - j.at)), h('td', {}, h('code', {}, j.command)),
    h('td', {}, stateMark(ctx, 'unknown', [ctx.t('std.pending') + left(j), j.text].filter(Boolean).join(' · ')))));
  // " (87 s)": the seconds until the wait gives up, counted down while a row is pending.
  const left = (j) => (j.until ? ` (${ctx.t('std.secs', { n: Math.max(0, Math.ceil((j.until - Date.now()) / 1000)) })})` : '');
  let tick = null;
  ctx.signal.addEventListener('abort', () => clearInterval(tick), { once: true });
  const drawTable = () => {
    const waiting = pendingRows();
    if (waiting.length && !tick) tick = setInterval(drawTable, 1000);
    if (!waiting.length && tick) { clearInterval(tick); tick = null; }
    if (!waiting.length && answered && !answered.length) { table.replaceChildren(h('tr', {}, h('td', { colspan: '4', class: 'muted' }, ctx.t('node.noHistory')))); return; }
    table.replaceChildren(...waiting, ...(answered || []));
  };
  ctx.signal.addEventListener('abort', onJobs(drawTable), { once: true });
  drawTable();
  events.then((list) => {
    const recent = list.filter((e) => e.node === device.node).slice(0, 6);
    answered = recent.map((e) => {
      const x = explainEvent(ctx, svc, e, device);
      const state = { ok: 'ok', refused: 'alert', forged: 'alert', silent: 'warn' }[x.kind] || 'unknown';
      const open = h('a', { href: `#result/${encodeURIComponent(e.id)}` }, h('code', {}, e.command));
      return h('tr', {}, h('td', { class: 'muted std-time' }, clockTime(ctx, e.at)), h('td', { class: 'muted std-took' }, tookText(ctx, e.tookMs)), h('td', {}, open),
        h('td', {}, stateMark(ctx, state, x.kind === 'ok' ? x.text : x.kind === 'silent' ? ctx.t('history.kind.silent') : x.text)));
    });
    drawTable();
  }).catch(() => {});

  return h('div', { class: 'std-panels' },
    statusPanel,
    panel('std-p-map', ctx.t('std.location'), mapSlot),
    panel('std-p-send', ctx.t('std.send'), line.el),
    panel('std-p-results', ctx.t('std.recent'),
      h('table', { class: 'std-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, ctx.t('std.time')), h('th', { scope: 'col' }, ctx.t('std.took')), h('th', { scope: 'col' }, ctx.t('std.command')), h('th', { scope: 'col' }, ctx.t('std.result')))),
        table),
      h('p', { class: 'std-actions' }, all)));
}
