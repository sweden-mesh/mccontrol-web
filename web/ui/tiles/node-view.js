// The selected node (W-20c, W-20j): its facts with their age, three 24-hour sparklines from
// Beacon (battery, airtime sent per hour, noise floor), its last commands and answers, and at the
// bottom the command line: type, Enter signs and sends to this node, or to the tagged nodes when
// some are tagged. The road switch (Auto / MQTT / Mesh) sits on the same line.
//
// The NODE tile shows it on a desktop; on a phone the "node" modal shows it full screen with the
// command line pinned to the bottom. nodeView(ctx, svc, id) works with either ctx: the tagged
// nodes come from ui/board-state.js, not from ctx.board.
//
// Sending reuses the jobs (lib/jobs) and the checks before signing (lib/jobs/checks preflight):
// a blocked command is said and not sent, a caution asks first, the mesh road connects the
// companion here. Every outcome lands in the history store (jobs.js) and so in RESULTS.
import { h } from '../dom.js';
import { deriveFacts } from '../../lib/store/index.js';
import { lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { blocker, preflight } from '../../lib/jobs/checks.js';
import { beaconBase, beaconClient } from '../../lib/stats/beacon.js';
import { CompanionError } from '../../lib/mesh/companion.js';
import { meshAfterMins } from '../screens/settings-store.js';
import { confirm, explain, explainEvent, nameOf } from '../screens/node-kit.js';
import { companionControl, roadLine } from '../screens/road-kit.js';
import { whyText } from '../screens/send.js';
import { tagged as taggedIds, onBoardChange, clearTags } from '../board-state.js';
import { age, s, stateMark } from './kit.js';
import { hourly, known, sparkRuns } from './data.js';
import { dataChanged, onDataChanged, reportBroker, startJob } from './sources.js';

const TELEMETRY_MAX_AGE = 15 * 60000;
const telemetry = new Map();   // node -> { at, promise }
let client = null;

async function beacon() {
  if (!client) client = beaconClient({ base: await beaconBase() });
  return client;
}

// The last 24 hours from Beacon, kept 15 minutes per node: { points, sampledAt, stats } or null.
export function readTelemetry(device, now = Date.now()) {
  const hit = telemetry.get(device.node);
  if (hit && now - hit.at < TELEMETRY_MAX_AGE) return hit.promise;
  const promise = (async () => {
    const c = await beacon();
    const oid = device.observerId || (await c.findNode(device.key || device.node)).observerId;
    if (!oid) return null;
    const [obs, tel] = await Promise.all([c.observer(oid), c.telemetry(oid, '24h')]);
    return { points: tel?.points || [], sampledAt: Number(obs?.lastStatusAt) || null, stats: obs?.statusMetadata?.stats || null };
  })();
  telemetry.set(device.node, { at: now, promise });
  promise.catch(() => telemetry.delete(device.node));
  return promise;
}

// A sparkline: the line (hidden from a screen reader) beside its words, which carry the values.
function spark(ctx, label, values, { unit, digits = 0, scale = 1, latestKnown = true }) {
  const vals = values.map((v) => (Number.isFinite(v) ? v / scale : null));
  const k = known(vals);
  const fmt = (v) => `${v.toFixed(digits)}${unit}`;
  const last = [...vals].reverse().find((v) => Number.isFinite(v));
  const runs = sparkRuns(vals, 96, 20);
  const words = k.length ? ctx.t('tile.sparkWords', { last: fmt(last), min: fmt(Math.min(...k)), max: fmt(Math.max(...k)) }) : ctx.t('tile.noData');
  const svg = runs.length ? s('svg', { class: 'spark', viewBox: '0 0 96 20', width: 96, height: 20, 'aria-hidden': 'true', focusable: 'false' },
    s('title', {}, `${label}: ${words}`),
    runs.map((pts) => s('polyline', { points: pts, class: 'spark-line' })),
    latestKnown && Number.isFinite(vals.at(-1)) ? s('circle', { class: 'spark-dot', r: 2,
      cx: runs.at(-1).split(' ').at(-1).split(',')[0], cy: runs.at(-1).split(' ').at(-1).split(',')[1] }) : null) : h('span', { class: 'spark spark-empty', 'aria-hidden': 'true' });
  return h('li', { class: 'row fact spark-row' },
    h('span', { class: 'fact-name' }, label),
    h('span', { class: 'fact-value' }, k.length ? fmt(last) : '–'),
    svg,
    h('span', { class: 'fact-age muted' }, k.length ? h('span', { class: 'visually-hidden' }, words) : null, ctx.t('tile.h24')));
}

// The datalist of the command table, as the send screen builds it.
let lists = 0;
function commandList(svc) {
  const id = `tile-cmds-${lists += 1}`;
  const seen = new Set();
  const opts = [];
  const add = (text) => { if (text && !seen.has(text) && !text.includes('<')) { seen.add(text); opts.push(h('option', { value: text })); } };
  for (const c of svc.data.commands.table) {
    if (c.text === 'get' || c.text === 'set') { c.examples.forEach((e) => add(e.split(':')[0].trim())); continue; }
    if (c.kind === 'none') add(c.text);
    for (const choice of c.choices) add(`${c.text} ${choice}`.trim());
    for (const ex of c.examples) add(`${c.text} ${ex}`);
  }
  return { id, el: h('datalist', { id }, opts) };
}

export function nodeView(ctx, svc, nodeId, { heading = null } = {}) {
  const head = h('div', { class: 'node-head' });
  const sparks = h('ul', { class: 'rows fact-list' });
  const facts = h('ul', { class: 'rows fact-list' });
  const log = h('ol', { class: 'rows node-log', 'aria-label': ctx.t('tile.log') });
  const links = h('p', { class: 'row node-links' },
    h('a', { href: `#nodeinfo/${nodeId}` }, ctx.t('tile.details')), ' ',
    h('a', { href: `#stats/${nodeId}` }, ctx.t('tile.stats')), ' ',
    h('a', { href: `#history/${nodeId}` }, ctx.t('tile.history')));
  const line = commandLine(ctx, svc, nodeId);
  const scroller = h('div', { class: 'node-scroll' }, head, sparks, h('hr', { class: 'rule' }), facts, h('hr', { class: 'rule' }), log, links);
  const el = h('div', { class: 'node-view' }, scroller, line.el);
  let device = null;

  async function draw() {
    device = await svc.stores.devices.get(nodeId);
    if (ctx.signal.aborted) return;
    if (!device) {
      heading?.(null);
      el.replaceChildren(h('p', { class: 'row muted' }, ctx.t('node.missing')));
      return;
    }
    heading?.(device);
    line.use(device);
    const events = await svc.stores.history.list({ node: device.node, limit: 60 });
    const heard = lastHeard(device);
    // Each part keeps its dot at its end, so a wrapped line never starts with one.
    const meta = [device.region, device.ver ? shortVersion(svc.rules, device.ver) : ctx.t('nodes.verUnknown'),
      [`${ctx.t('tile.heard')} `, heard ? age(ctx, heard) : ctx.t('nodes.heardUnknown')],
      device.key && svc.rules.speaksV2(device.ver) ? ctx.t('tile.v2') : ctx.t('tile.v1')];
    head.replaceChildren(h('p', { class: 'row node-meta' },
      meta.map((m, i) => h('span', { class: 'meta-part' }, m, i < meta.length - 1 ? '\u00a0·' : ''))));
    // facts with their age, the configured labels first
    const { facts: f, raw } = deriveFacts(device, events, svc.rules.parseFacts);
    const order = svc.data.facts.labels.map(([k]) => k);
    const label = Object.fromEntries(svc.data.facts.labels);
    const keys = Object.keys(f).sort((a, b) => ((order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999)) || a.localeCompare(b));
    const factRow = (name, value, fact) => h('li', { class: 'row fact' },
      h('span', { class: 'fact-name' }, name), h('code', { class: 'fact-value' }, value),
      h('span', { class: 'fact-age muted' }, age(ctx, fact.at), fact.verified === null ? ` ${ctx.t('tile.unsignedShort')}` : ''));
    const rows = [...keys.map((k) => factRow(label[k] || k, f[k].value, f[k])),
      ...Object.entries(raw).slice(0, 6).map(([cmd, r]) => factRow(cmd, r.reply.length > 40 ? `${r.reply.slice(0, 40)}…` : r.reply, r))];
    facts.replaceChildren(...(rows.length ? rows : [h('li', { class: 'row muted' }, ctx.t('node.noFacts'))]));
    // the log: last commands and their answers
    const recent = events.slice(0, 12).map((e) => {
      const x = explainEvent(ctx, svc, e);
      const state = { ok: 'ok', refused: 'alert', forged: 'alert', silent: 'warn' }[x.kind] || 'unknown';
      return h('li', { class: `row log-row${x.kind === 'refused' || x.kind === 'forged' ? ' alert' : ''}` },
        h('code', { class: 'log-cmd' }, `> ${e.command}`),
        stateMark(ctx, state, ctx.t(`history.kind.${x.kind}`)),
        h('span', { class: 'log-text' }, x.kind === 'ok' ? x.text : x.kind === 'refused' ? x.text : ''),
        h('span', { class: 'fact-age muted' }, e.road === 'mesh' ? `${ctx.t('tile.mesh')} · ` : '', age(ctx, e.at)));
    });
    log.replaceChildren(...(recent.length ? recent : [h('li', { class: 'row muted' }, ctx.t('node.noHistory'))]));
    drawSparks();
  }

  async function drawSparks() {
    const d = device;
    sparks.replaceChildren(h('li', { class: 'row muted' }, ctx.t('node.loading')));
    try {
      const tel = await readTelemetry(d);
      if (ctx.signal.aborted || d !== device) return;
      if (!tel) { sparks.replaceChildren(h('li', { class: 'row muted' }, ctx.t('tile.noBeacon'))); return; }
      const now = Date.now();
      sparks.replaceChildren(
        spark(ctx, ctx.t('tile.battery'), hourly(tel.points, 'batteryMv', now), { unit: ' V', digits: 2, scale: 1000 }),
        spark(ctx, ctx.t('tile.airtime'), hourly(tel.points, 'airtimeTxSecs', now, { diff: true }), { unit: ' s', digits: 0 }),
        spark(ctx, ctx.t('tile.noise'), hourly(tel.points, 'noiseFloorDb', now), { unit: ' dBm', digits: 0 }),
        tel.sampledAt ? h('li', { class: 'row muted small-row' }, ctx.t('tile.beaconAge'), ' ', age(ctx, tel.sampledAt)) : null);
    } catch {
      if (!ctx.signal.aborted) sparks.replaceChildren(h('li', { class: 'row muted' }, ctx.t('tile.noBeacon')));
    }
  }

  ctx.signal.addEventListener('abort', onDataChanged(() => draw().catch(() => {})), { once: true });
  draw().catch((e) => el.replaceChildren(h('p', { class: 'row tile-err' }, e.message)));
  return el;
}

// The command line: "Gisebo ▶ [command] road [auto|mqtt|mesh] [Send]", the checks under it.
function commandLine(ctx, svc, nodeId) {
  const list = commandList(svc);
  const input = h('input', { type: 'text', list: list.id, class: 'cmd', autocomplete: 'off', autocapitalize: 'none',
    spellcheck: 'false', enterkeyhint: 'send', 'aria-describedby': `cl-check-${nodeId}` });
  const prompt = h('label', { class: 'cmd-prompt' });
  const road = h('select', { class: 'road', 'aria-label': ctx.t('road.legend') },
    ['auto', 'mqtt', 'mesh'].map((r) => h('option', { value: r }, ctx.t(`tile.road.${r}`))));
  const send = h('button', { type: 'submit', class: 'button cmd-send' }, ctx.t('tile.send'));
  const check = h('p', { class: 'cmd-check', id: `cl-check-${nodeId}`, 'aria-live': 'polite' });
  const companionSlot = h('div', { class: 'cmd-companion' });
  const out = h('div', { class: 'cmd-out', 'aria-live': 'polite' });
  const form = h('form', { class: 'cmd-line', novalidate: true },
    h('div', { class: 'cmd-row' }, prompt, input, road, send), list.el, check, companionSlot, out);
  const id = `cmd-${nodeId}`;
  input.id = id;
  prompt.setAttribute('for', id);
  let device = null;
  let all = [];
  let running = false;
  let companion = null;

  // Who it goes to: the tagged nodes when any are tagged, else this one.
  const targets = () => {
    const tags = taggedIds();
    if (!tags.length) return device ? [device] : [];
    return tags.map((n) => all.find((d) => d.node === n)).filter(Boolean);
  };

  // For several nodes each is checked on its own: one that cannot take the command is left out
  // (the send says so) and blocks the send only when none can.
  const verdict = () => {
    const to = targets();
    const p = preflight(svc.rules, { command: input.value, device: to[0] || null, road: road.value, meshAfterMins: meshAfterMins() });
    if (to.length <= 1 || !p.command) return { ...p, skip: [], refuse: [] };
    const skip = to.map((d) => [d, blocker(svc.rules, { command: p.command, device: d, road: road.value })]).filter(([, x]) => x);
    const refuse = road.value === 'mqtt' ? to.filter((d) => d.ver && !svc.rules.admits(d.ver, p.command)) : [];
    return { ...p, block: skip.length === to.length ? skip[0][1] : null, skip, refuse };
  };

  function drawPrompt() {
    const to = targets();
    const many = to.length > 1 || (to.length === 1 && to[0] !== device);
    prompt.replaceChildren(many ? ctx.t('tile.toTagged', { n: to.length }) : (device ? nameOf(device) : nodeId), h('span', { 'aria-hidden': 'true' }, ' ▶'));
    send.textContent = many ? ctx.t('tile.sendTagged', { n: to.length }) : ctx.t('tile.send');
    const meshOnly = to.some((d) => svc.rules.deviceMeshOnly(d));
    road.querySelector('option[value="mqtt"]').disabled = meshOnly;
    if (meshOnly && road.value === 'mqtt') road.value = 'auto';
  }

  function drawChecks() {
    const p = verdict();
    const to = targets();
    let text = '';
    let kind = '';
    if (p.command && p.block) { text = `${ctx.t('send.blocked')} ${whyText(ctx, p.block)}`; kind = 'alert'; }
    else if (p.command && p.caution) { text = `${ctx.t('send.caution')} ${p.caution}`; kind = 'warn'; }
    else if (p.command && to.length === 1 && p.admits === false) {
      text = p.lacks ? ctx.t('send.lacks', { feature: p.lacks, version: to[0].ver }) : ctx.t('send.notAdmitted', { version: to[0].ver, needs: p.needs || '?' });
      kind = 'warn';
    } else if (p.command && to.length === 1 && p.road?.road === 'mesh') {
      text = p.road.why ? ctx.t('road.willMesh', { why: ctx.t(`road.why.${p.road.why.code}`, p.road.why.vars) }) : ctx.t('road.willMeshPlain');
    } else if (p.command && to.length > 1) {
      text = [ctx.t('send.perNode', { n: to.length }),
        p.skip.length ? ctx.t('tile.skipped', { n: p.skip.length, names: p.skip.map(([d]) => nameOf(d)).join(', ') }) : '',
        p.refuse.length ? ctx.t('send.someRefuse', { n: p.refuse.length, names: p.refuse.map(nameOf).join(', ') }) : ''].filter(Boolean).join(' ');
      if (p.skip.length || p.refuse.length) kind = 'warn';
    }
    check.textContent = text;
    check.dataset.kind = kind;
    check.hidden = !text;
    const show = road.value !== 'mqtt' || to.some((d) => svc.rules.deviceMeshOnly(d));
    if (show && !companion) companion = companionControl(ctx);
    companionSlot.replaceChildren(show ? companion : '');
  }

  input.addEventListener('input', drawChecks, { signal: ctx.signal });
  road.addEventListener('change', drawChecks, { signal: ctx.signal });
  const onTags = () => { drawPrompt(); drawChecks(); };
  ctx.signal.addEventListener('abort', onBoardChange((st) => { if (st.what === 'tagged') onTags(); }), { once: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const p = verdict();
    const to = targets();
    if (!p.command || !to.length) { input.focus(); return; }
    if (p.block) { drawChecks(); input.focus(); return; }
    if (p.caution) {
      const ok = await confirm(ctx, {
        title: ctx.t('send.confirmTitle'),
        lines: [h('p', {}, h('code', {}, p.command), ' → ', to.map(nameOf).join(', ')), h('p', {}, p.caution)],
        confirmLabel: ctx.t('send.confirmButton'), danger: true,
      });
      if (!ok) return;
    }
    running = true;
    send.disabled = true;
    const label = `${p.command} → ${to.length === 1 ? nameOf(to[0]) : ctx.t('tile.nNodes', { n: to.length })}`;
    const job = startJob({ label });
    const bar = h('progress', { max: '1', 'aria-label': label });
    const words = h('span', {});
    out.replaceChildren(h('div', { class: 'row job-line' }, bar, words));
    try {
      const res = await svc.jobs.send({
        command: p.command, nodes: to.map((d) => d.node), road: road.value,
        onProgress: (st) => {
          const fraction = st.total ? st.elapsed / st.total : null;
          const text = ctx.t('send.waitNode', { name: st.name, i: (st.index ?? 0) + 1, of: st.count ?? to.length });
          if (fraction === null) bar.removeAttribute('value'); else bar.value = Math.max(0, Math.min(1, fraction));
          words.textContent = text;
          job.progress(fraction, text);
        },
      });
      if (res.outcomes.some((o) => o.sent && o.road !== 'mesh')) reportBroker({ ok: true });
      const lines = res.outcomes.map((o) => {
        if (!o.sent) return h('li', { class: 'row' }, h('span', { class: 'log-who' }, o.name), stateMark(ctx, 'alert', ctx.t('send.notSent')),
          h('span', {}, o.reason ? ctx.t(`send.why.${o.reason.code}`, o.reason.vars) : ''));
        const x = explain(ctx, svc, o.result, all.find((d) => d.node === o.node), o.road);
        const how = roadLine(ctx, o);
        return h('li', { class: 'row' }, h('span', { class: 'log-who' }, o.name),
          stateMark(ctx, { ok: 'ok', refused: 'alert', forged: 'alert', silent: 'warn' }[x.kind], ctx.t(`history.kind.${x.kind}`)),
          h('span', {}, x.kind === 'ok' || x.kind === 'refused' ? x.text : x.help), how ? h('span', { class: 'muted' }, ` ${how}`) : null);
      });
      out.replaceChildren(h('p', { class: 'row' }, ctx.t('send.summary', { command: res.command, answered: res.answered, asked: res.asked })),
        h('ul', { class: 'rows' }, lines));
      ctx.announce(ctx.t('send.doneSummary', { answered: res.answered, asked: res.asked }));
      if (taggedIds().length && res.outcomes.every((o) => o.sent)) clearTags();
      input.value = '';
      drawChecks();
    } catch (err) {
      if (err?.code === 'broker' || (!err?.code && !(err instanceof CompanionError))) reportBroker({ ok: false, detail: err.message });
      const text = err.code === 'locked' ? ctx.t('send.locked')
        : err instanceof CompanionError ? ctx.t('send.why.companion', { detail: err.message })
          : err.code ? ctx.t(`send.why.${err.code}`, err.vars) : err.message;
      out.replaceChildren(h('p', { class: 'row tile-err', role: 'alert' }, text,
        err.code === 'locked' ? [' ', h('a', { href: '#unlock' }, ctx.t('send.unlockLink'))] : null));
    } finally {
      job.done();
      running = false;
      send.disabled = false;
      dataChanged('history');
    }
  }, { signal: ctx.signal });

  return {
    el: form,
    async use(d) {
      device = d;
      all = await svc.stores.devices.list();
      const meshOnly = svc.rules.deviceMeshOnly(d);
      if (!form.dataset.ready) { road.value = meshOnly ? 'auto' : 'mqtt'; form.dataset.ready = '1'; }
      drawPrompt();
      drawChecks();
    },
  };
}
