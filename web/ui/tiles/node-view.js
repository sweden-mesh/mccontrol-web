// The selected node (W-20c, W-20j): its facts with their age, three 24-hour sparklines from
// Beacon (battery, airtime sent per hour, noise floor), buttons for its details, statistics and
// history (W-28e), and at the bottom the command line: type, Enter signs and sends to this node, or to
// the tagged nodes when some are tagged. The road switch (Auto / MQTT / Mesh) sits on the same
// line (it starts on the node's last choice, else MQTT, or the mesh for a node without MQTT: W-26b,
// W-26c). A command's answer is shown once, in HISTORY (W-23g): not here as a log, not under the
// line. The command area is two fixed rows (W-23h, W-23i): the line, and the companion's state
// when the road may take the mesh; what is wrong with a command tints the field and is its
// description, never a third row.
//
// The NODE tile shows it on a desktop; on a phone the "node" modal shows it full screen with the
// command line pinned to the bottom. nodeView(ctx, svc, id) works with either ctx: the tagged
// nodes come from ui/board-state.js, not from ctx.board.
//
// Sending reuses the jobs (lib/jobs) and the checks before signing (lib/jobs/checks preflight):
// a blocked command is not sent, a caution asks first, the mesh road connects the companion
// here. Every outcome lands in the history store (jobs.js) and so in HISTORY.
import { h } from '../dom.js';
import { deriveFacts } from '../../lib/store/index.js';
import { batteryKnown, lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { blocker, preflight } from '../../lib/jobs/checks.js';
import { beaconBase, beaconClient } from '../../lib/stats/beacon.js';
import { CompanionError } from '../../lib/mesh/companion.js';
import { lowBatteryVolts, meshAfterMins, notHeardHours } from '../screens/settings-store.js';
import { confirm, nameOf, volts } from '../screens/node-kit.js';
import { companionBrief } from '../screens/road-kit.js';
import { companion as connectedCompanion, onCompanion } from '../companion-session.js';
import { startRoad } from '../../lib/jobs/road.js';
import { whyText } from '../screens/send.js';
import { tagged as taggedIds, onBoardChange, clearTags } from '../board-state.js';
import { age, s } from './kit.js';
import { GLYPH } from '../statusline.js';
import { hourly, known, newCounts, nodeStatus, sparkRuns } from './data.js';
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
function spark(ctx, label, values, { unit, digits = 0, scale = 1, latestKnown = true, none = '–' }) {
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
    h('span', { class: 'fact-value' }, k.length ? fmt(last) : none),
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
  // Real buttons in the page's button style, not underlined links (W-28e).
  const go = (hash, label) => {
    const b = h('button', { type: 'button', class: 'tool node-link' }, label);
    b.addEventListener('click', () => ctx.navigate(hash), { signal: ctx.signal });
    return b;
  };
  const links = h('p', { class: 'row node-links' },
    go(`#nodeinfo/${nodeId}`, ctx.t('tile.details')),
    go(`#stats/${nodeId}`, ctx.t('tile.stats')),
    go(`#history/${nodeId}`, ctx.t('tile.history')));
  const line = commandLine(ctx, svc, nodeId);
  const scroller = h('div', { class: 'node-scroll' }, head, sparks, h('hr', { class: 'rule' }), facts, h('hr', { class: 'rule' }), links);
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
    const [events, seen] = await Promise.all([svc.stores.history.list({ node: device.node, limit: 60 }), svc.stores.meta.get('resultsSeen')]);
    if (ctx.signal.aborted) return;
    const heard = lastHeard(device);
    // The node's results not yet seen in HISTORY (W-26g: moved here from NODES).
    const fresh = newCounts(events, seen)[device.node] || 0;
    // Each part keeps its dot at its end, so a wrapped line never starts with one.
    const meta = [...(fresh ? [h('a', { class: 'node-new', href: `#history/${device.node}` }, ctx.t('tile.newCount', { n: fresh }))] : []), device.region, device.ver ? shortVersion(svc.rules, device.ver) : ctx.t('nodes.verUnknown'),
      [`${ctx.t('tile.heard')} `, heard ? age(ctx, heard) : ctx.t('nodes.heardUnknown')],
      device.key && svc.rules.speaksV2(device.ver) ? ctx.t('tile.v2') : ctx.t('tile.v1')];
    // Why it needs attention, whole: NODES cuts it to fit its row (W-23d).
    const st = nodeStatus(device, { now: Date.now(), hours: notHeardHours(), thresholdMv: lowBatteryVolts() * 1000, rules: svc.rules });
    const why = st.reasons.map((r) => ctx.t(`dash.att.${r.kind}`, r.vars)).join('; ');
    head.replaceChildren(h('p', { class: 'row node-meta' },
      meta.map((m, i) => h('span', { class: 'meta-part' }, m, i < meta.length - 1 ? '\u00a0·' : ''))),
    why ? h('p', { class: `row node-why-line${st.state === 'alert' ? ' alert' : ''}` }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[st.state]), h('span', {}, why)) : null);
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
        spark(ctx, ctx.t('tile.battery'), hourly(tel.points, 'batteryMv', now).map((mv) => (batteryKnown(mv) ? mv : null)),
          { unit: ' V', digits: 2, scale: 1000, none: volts(ctx.t, null) }),
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

// The road (W-28d): a segmented switch of three radios in the page's button style, not a native
// select, so it matches the fields and buttons in every theme and has no browser popup.
// `value` reads and sets the checked one; setDisabled(value, on); 'change' bubbles from the radios.
export function roadSwitch(ctx, nodeId) {
  const name = `road-${nodeId}-${lists += 1}`;
  const radios = ['auto', 'mqtt', 'mesh'].map((r) => h('input', { type: 'radio', name, value: r, class: 'seg-input' }));
  const el = h('fieldset', { class: 'seg road' },
    h('legend', { class: 'visually-hidden' }, ctx.t('road.legend')),
    radios.map((input) => h('label', { class: 'seg-option' }, input, h('span', {}, ctx.t(`tile.road.${input.value}`)))));
  radios[0].checked = true;
  Object.defineProperty(el, 'value', {
    get: () => radios.find((r) => r.checked)?.value || 'auto',
    set: (v) => { const r = radios.find((x) => x.value === v); if (r) r.checked = true; },
  });
  el.setDisabled = (v, on) => { const r = radios.find((x) => x.value === v); if (r) r.disabled = on; };
  return el;
}

// The command line: "Gisebo ▶ [command] road [auto|mqtt|mesh] [Send]", and under it one row for
// the companion when the road may take the mesh (empty otherwise, so the area keeps its height).
// The checks are the field's state and description: a command that cannot go (or stops before
// its value) tints the field and disables Send; a caution or a refusal to come marks its border;
// the reason is the field's description and its tooltip (W-23h).
function commandLine(ctx, svc, nodeId) {
  const list = commandList(svc);
  const checkId = `cl-check-${nodeId}`;
  const input = h('input', { type: 'text', list: list.id, class: 'cmd', autocomplete: 'off', autocapitalize: 'none',
    spellcheck: 'false', enterkeyhint: 'send', 'aria-describedby': checkId, 'aria-invalid': 'false' });
  const prompt = h('label', { class: 'cmd-prompt' });
  const road = roadSwitch(ctx, nodeId);
  const send = h('button', { type: 'submit', class: 'button cmd-send' }, ctx.t('tile.send'));
  const check = h('span', { class: 'visually-hidden', id: checkId });
  const companionSlot = h('div', { class: 'cmd-companion' });
  const form = h('form', { class: 'cmd-line', novalidate: true },
    h('div', { class: 'cmd-row' }, prompt, input, road, send), list.el, check, companionSlot);
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
    road.setDisabled('mqtt', meshOnly);
    if (meshOnly && road.value === 'mqtt') road.value = 'auto';
  }

  const needsText = (c) => (c.kind === 'text'
    ? ctx.t('tile.needsText', { command: c.text, example: c.examples.find((e) => !e.includes('<')) || c.examples[0] || '' })
    : ctx.t('tile.needsChoice', { command: c.text, choices: c.choices.join(', ') }));

  // { text, kind }: kind 'invalid' (not sent: Send is off), 'warn' (sent, but read this) or ''.
  function checkText() {
    const p = verdict();
    const to = targets();
    if (!p.command) return { text: '', kind: '' };
    if (p.block) return { text: `${ctx.t('send.blocked')} ${whyText(ctx, p.block)}`, kind: 'invalid' };
    if (p.incomplete) return { text: needsText(p.incomplete), kind: 'invalid' };
    if (p.caution) return { text: `${ctx.t('send.caution')} ${p.caution}`, kind: 'warn' };
    if (to.length === 1 && p.admits === false) {
      return { text: p.lacks ? ctx.t('send.lacks', { feature: p.lacks, version: to[0].ver }) : ctx.t('send.notAdmitted', { version: to[0].ver, needs: p.needs || '?' }), kind: 'warn' };
    }
    if (to.length === 1 && p.road?.road === 'mesh') {
      return { text: p.road.why ? ctx.t('road.willMesh', { why: ctx.t(`road.why.${p.road.why.code}`, p.road.why.vars) }) : ctx.t('road.willMeshPlain'), kind: '' };
    }
    if (to.length > 1) {
      const text = [ctx.t('send.perNode', { n: to.length }),
        p.skip.length ? ctx.t('tile.skipped', { n: p.skip.length, names: p.skip.map(([d]) => nameOf(d)).join(', ') }) : '',
        p.refuse.length ? ctx.t('send.someRefuse', { n: p.refuse.length, names: p.refuse.map(nameOf).join(', ') }) : ''].filter(Boolean).join(' ');
      return { text, kind: p.skip.length || p.refuse.length ? 'warn' : '' };
    }
    return { text: '', kind: '' };
  }

  function drawChecks() {
    const { text, kind } = checkText();
    check.textContent = text;
    input.title = text;
    input.dataset.check = kind;
    input.setAttribute('aria-invalid', kind === 'invalid' ? 'true' : 'false');
    send.disabled = running || kind === 'invalid' || !input.value.trim();
    const to = targets();
    const show = road.value !== 'mqtt' || to.some((d) => svc.rules.deviceMeshOnly(d));
    if (show && !companion) companion = companionBrief(ctx);
    companionSlot.replaceChildren(...(show ? [h('span', { class: 'muted' }, ctx.t('tile.line.companion'), ' '), companion] : []));
  }

  // The road starts on the node's last choice, else MQTT, or the mesh for a node without MQTT (W-26b,
  // W-26c); a choice made here is stored with the node, and until one is, a companion connecting
  // or going away moves the start with it.
  let chosen = false;
  const pickStart = () => {
    if (!device || chosen) return;
    road.value = startRoad({ remembered: device.road, companion: Boolean(connectedCompanion()), meshOnly: svc.rules.deviceMeshOnly(device) });
    drawPrompt();
    drawChecks();
  };
  ctx.signal.addEventListener('abort', onCompanion(pickStart), { once: true });
  input.addEventListener('input', drawChecks, { signal: ctx.signal });
  road.addEventListener('change', () => {
    chosen = true;
    if (device) svc.stores.devices.update(device.node, { road: road.value }).then((d) => { device = d; }).catch(() => {});
    drawChecks();
  }, { signal: ctx.signal });
  const onTags = () => { drawPrompt(); drawChecks(); };
  ctx.signal.addEventListener('abort', onBoardChange((st) => { if (st.what === 'tagged') onTags(); }), { once: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const p = verdict();
    const to = targets();
    if (!p.command || !to.length || p.block || p.incomplete) { drawChecks(); input.focus(); return; }
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
    // The progress is HISTORY' job bar; the answers are HISTORY' rows.
    const label = `${p.command} → ${to.length === 1 ? nameOf(to[0]) : ctx.t('tile.nNodes', { n: to.length })}`;
    const job = startJob({ label });
    try {
      const res = await svc.jobs.send({
        command: p.command, nodes: to.map((d) => d.node), road: road.value,
        onProgress: (st) => {
          const fraction = st.total ? st.elapsed / st.total : null;
          job.progress(fraction, ctx.t('send.waitNode', { name: st.name, i: (st.index ?? 0) + 1, of: st.count ?? to.length }));
        },
      });
      if (res.outcomes.some((o) => o.sent && o.road !== 'mesh')) reportBroker({ ok: true });
      ctx.announce(ctx.t('send.doneSummary', { answered: res.answered, asked: res.asked }));
      if (taggedIds().length && res.outcomes.every((o) => o.sent)) clearTags();
      input.value = '';
    } catch (err) {
      if (err?.code === 'broker' || (!err?.code && !(err instanceof CompanionError))) reportBroker({ ok: false, detail: err.message });
      const text = err.code === 'locked' ? ctx.t('send.locked')
        : err instanceof CompanionError ? ctx.t('send.why.companion', { detail: err.message })
          : err.code ? ctx.t(`send.why.${err.code}`, err.vars) : err.message;
      ctx.notify(text, { kind: 'error' });
    } finally {
      job.done();
      running = false;
      drawChecks();
      dataChanged('history');
    }
  }, { signal: ctx.signal });

  return {
    el: form,
    async use(d) {
      device = d;
      all = await svc.stores.devices.list();
      if (!form.dataset.ready) { form.dataset.ready = '1'; pickStart(); return; }
      drawPrompt();
      drawChecks();
    },
  };
}
