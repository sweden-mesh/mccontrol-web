// HISTORY (W-20c, renamed from RESULTS in W-25d): the selected node's answers, refusals and
// silences, newest first; every node's, labelled so, when none is selected. A result stays new
// until it is seen. A result is
// seen when it is opened (click or Enter: the "result" modal shows it whole) or with "Mark all
// seen"; a reload does not clear anything (beta.2's "since your last visit" emptied itself on
// every load, finding 2). Seen results stay, dimmed, under the new ones. A running job is a bar
// on its own line at the top. "All history" opens the history modal. How many are new is per node
// in NODES (newCounts in data.js), not in this tile's title, which names whose history it shows.
//
// What is seen is kept per key in the meta store ('resultsSeen': { upTo, ids }), so it survives a
// reload and holds on another tab of the same browser after its next draw.
import { h } from '../dom.js';
import { setSelected } from '../board-state.js';
import { explainEvent, nameOf } from '../screens/node-kit.js';
import { resultKind } from '../../lib/store/index.js';
import { clockTime, everyMinute, forKey, stateMark } from './kit.js';
import { historyFor, isSeen, markAllSeen, markSeen, sharedPrefix } from './data.js';
import { dataChanged, jobs, onDataChanged, onJobs } from './sources.js';

export const id = 'results';
export const title = 'tile.results';

const SHOWN = 30;
const KIND_STATE = Object.freeze({ ok: 'ok', refused: 'alert', forged: 'alert', silent: 'warn', summary: 'unknown' });

export function render(ctx) {
  const body = h('div', { class: 'tile-fill results-tile' });
  forKey(ctx, body, (svc) => fill(ctx, svc, body));
  return body;
}

function fill(ctx, svc, body) {
  const bars = h('ul', { class: 'rows job-rows', 'aria-label': ctx.t('tile.running') });
  const list = h('ul', { class: 'rows result-rows' });
  const markAll = h('button', { type: 'button', class: 'link-button' }, ctx.t('tile.markAllSeen'));
  const foot = h('p', { class: 'tile-foot' }, markAll, ' ', h('a', { href: '#history' }, ctx.t('tile.openHistory')));
  body.replaceChildren(bars, list, foot);
  let shownNew = [];
  let scope = null;          // the node whose history is shown, or null: every node's

  const drawJobs = () => {
    bars.replaceChildren(...jobs().map((j) => {
      const bar = h('progress', { max: '1', 'aria-label': j.label });
      if (j.fraction !== null) bar.value = j.fraction;
      return h('li', { class: 'row job-line' }, h('span', { class: 'job-label' }, j.label), bar, h('span', { class: 'muted job-text' }, j.text));
    }));
    bars.hidden = !bars.children.length;
  };

  let drawing = 0;
  async function draw() {
    const mine = ++drawing;   // a later draw (another node selected meanwhile) wins
    const [all, devices, seen] = await Promise.all([
      svc.stores.history.list({ limit: 200 }), svc.stores.devices.list(), svc.stores.meta.get('resultsSeen')]);
    if (ctx.signal.aborted || mine !== drawing) return;
    // The column is narrow: the part of each name that tells it apart (the whole one in its title).
    const full = Object.fromEntries(devices.map((d) => [d.node, nameOf(d)]));
    const byNode = Object.fromEntries(devices.map((d) => [d.node, d]));
    const prefix = sharedPrefix(Object.values(full));
    const names = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, v.startsWith(prefix) ? v.slice(prefix.length) : v]));
    const selected = ctx.board.selected();
    scope = selected && byNode[selected] ? selected : null;
    const events = historyFor(all, scope);
    const fresh = events.filter((e) => !isSeen(e, seen));
    const old = events.filter((e) => isSeen(e, seen)).slice(0, Math.max(0, SHOWN - fresh.length));
    shownNew = fresh;
    ctx.tile.setTitle(scope ? names[scope] || scope : ctx.t('tile.historyAll'));
    list.setAttribute('aria-label', scope ? ctx.t('tile.historyOf', { name: full[scope] }) : ctx.t('tile.historyAllNodes'));
    markAll.hidden = !fresh.length;
    markAll.textContent = ctx.t(scope ? 'tile.markNodeSeen' : 'tile.markAllSeen');
    const now = Date.now();
    const row = (e, isNew) => {
      const kind = resultKind(e);
      const x = explainEvent(ctx, svc, e, byNode[e.node] || null);
      const who = e.node ? names[e.node] || e.node : e.region;
      const what = kind === 'ok' ? x.text : kind === 'refused' ? x.text : kind === 'summary' ? e.note : '';
      const button = h('button', { type: 'button', class: 'result-row', 'data-id': e.id },
        h('span', { class: 'res-time' }, clockTime(ctx, e.at, now)),
        h('span', { class: 'res-who', title: e.node ? full[e.node] || e.node : e.region }, who),
        stateMark(ctx, KIND_STATE[kind], ctx.t(`history.kind.${kind}`)),
        h('span', { class: 'res-what' }, h('code', {}, e.command), what ? ` ${what}` : ''),
        isNew ? h('span', { class: 'visually-hidden' }, ctx.t('tile.new')) : null);
      button.addEventListener('click', () => ctx.modal.open('result', e.id));
      return h('li', { class: `result-item${isNew ? ' is-new' : ' is-seen'}${isNew && KIND_STATE[kind] === 'alert' ? ' alert' : ''}` }, button);
    };
    const shown = [...fresh.slice(0, SHOWN).map((e) => row(e, true)), ...old.map((e) => row(e, false))];
    const none = scope ? ctx.t('tile.noResultsNode', { name: full[scope] }) : ctx.t('tile.noResults');
    list.replaceChildren(...(shown.length ? shown : [h('li', { class: 'row muted' }, none)]));
  }

  markAll.addEventListener('click', async () => {
    // Every node's: all up to the newest. One node's: only its own, the others stay new.
    const seen = await svc.stores.meta.get('resultsSeen');
    await svc.stores.meta.set('resultsSeen', scope ? markSeen(seen, shownNew.map((e) => e.id)) : markAllSeen(shownNew));
    ctx.announce(ctx.t(scope ? 'tile.nodeSeen' : 'tile.allSeen'));
    dataChanged('seen');
  }, { signal: ctx.signal });

  // ↑ ↓ between results (one tab stop would hide them from a quick Tab; each is a button).
  list.addEventListener('keydown', (e) => {
    const b = e.target.closest?.('.result-row');
    if (!b || !['ArrowDown', 'ArrowUp'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const all = [...list.querySelectorAll('.result-row')];
    const next = all[all.indexOf(b) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }, { signal: ctx.signal });

  const redraw = () => draw().catch((e) => console.error('results tile:', e));
  ctx.signal.addEventListener('abort', onJobs(drawJobs), { once: true });
  ctx.signal.addEventListener('abort', onDataChanged(redraw), { once: true });
  // Opening a result marks it seen; closing the modal redraws.
  ctx.modal.on((m) => { if (!m) redraw(); });
  ctx.board.on((st) => { if (st.what === 'selected') redraw(); });
  everyMinute(ctx.signal, redraw);
  drawJobs();
  redraw();
}

// The "result" modal (#result/<event id>): one result whole, what its code means, the reply as
// it came, signed or not, the road and the topic. Opening it marks it seen. Registered with the
// other modals in ui/modals/index.js.
export const resultModal = Object.freeze({
  name: 'result',
  title: 'tile.resultTitle',
  closedby: 'any',
  render(ctx) {
    const eventId = String(ctx.args[0] || '');
    const heading = h('h1', { id: 'result-title' }, ctx.t('tile.resultTitle'));
    const body = h('div', { class: 'result-modal-body' });
    forKey(ctx, body, async (svc) => {
      const all = await svc.stores.history.list({});
      const e = all.find((x) => x.id === eventId);
      if (!e) { body.replaceChildren(h('p', {}, ctx.t('tile.noSuchResult'), ' ', h('a', { href: '#history' }, ctx.t('tile.openHistory')))); return; }
      const device = e.node ? await svc.stores.devices.get(e.node) : null;
      const kind = resultKind(e);
      const x = explainEvent(ctx, svc, e, device);
      const who = device ? nameOf(device) : e.node || e.region;
      heading.textContent = ctx.t('tile.resultHeading', { command: e.command, who });
      const at = new Date(e.at);
      const pair = (k, v) => (v === null || v === undefined || v === '' ? null : [h('dt', {}, k), h('dd', {}, v)]);
      const open = e.node ? h('button', { type: 'button', class: 'tool' }, ctx.t('tile.openOnBoard', { name: who })) : null;
      open?.addEventListener('click', () => { setSelected(e.node); if (matchMedia('(width < 45em)').matches) ctx.modal.open('node', e.node); else ctx.close(); });
      const signature = e.verified === true ? ctx.t('send.res.signed') : e.verified === false ? ctx.t('send.res.forged') : e.code === null ? null : ctx.t('send.res.unsigned');
      body.replaceChildren(
        h('p', { class: `row${KIND_STATE[kind] === 'alert' ? ' alert' : ''}` }, stateMark(ctx, KIND_STATE[kind], ctx.t(`history.kind.${kind}`))),
        e.reply ? h('pre', { class: 'result-reply' }, e.reply) : null,
        x.help && x.help !== signature ? h('p', {}, x.help) : null,   // said once, in the facts, when it is the signature
        h('dl', { class: 'facts result-facts' },
          pair(ctx.t('tile.when'), h('time', { datetime: at.toISOString() }, at.toLocaleString(ctx.lang))),
          pair(ctx.t('tile.command'), h('code', {}, e.command)),
          pair(ctx.t('tile.code'), e.code === null ? null : `${e.code}${e.codeName ? ` ${e.codeName}` : ''}`),
          pair(ctx.t('tile.signature'), signature),
          pair(ctx.t('tile.road'), ctx.t(e.road === 'mesh' ? 'tile.roadMesh' : 'tile.roadMqtt')),
          pair(ctx.t('tile.topic'), e.topic ? h('code', {}, e.topic) : null)),
        h('p', { class: 'row wrap' }, open, e.node ? h('a', { class: 'tool', href: `#history/${e.node}` }, ctx.t('tile.history')) : null));
      const seen = await svc.stores.meta.get('resultsSeen');
      if (!isSeen(e, seen)) { await svc.stores.meta.set('resultsSeen', markSeen(seen, [e.id])); dataChanged('seen'); }
    });
    return h('section', { class: 'result-modal', 'aria-labelledby': 'result-title' }, heading, body);
  },
});
