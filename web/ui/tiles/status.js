// STATUS (W-20c, W-20e): the states that gate everything, one line each, and each line a button
// where it can act: the command server (Test; W-28a: broker-source.js), key (Unlock / Lock), registration (Register), companion
// (the chooser), the Beacon status refresh (Refresh now) and discovery (Look now). It
// also sets the header's `broker` item.
//
// Registration, refresh and discovery are other streams' work (automatic registration, W-20e's
// 15-minute Beacon refresh, W-20a's discovery). They plug in through ui/tiles/sources.js
// (provideSource); until one is provided its line here is a stand-in:
//   broker        provided by broker-source.js (W-28a); before that, the last send or Test
//   registration  "not known": Register opens Setup's key tab, where it is done today
//   refresh       the newest Beacon read stored on a device, the next due 15 minutes after it;
//                 Refresh now reads Beacon (no transmission)
//   discovery     "not run here": Look now opens today's discovery form
// The page's automation (ui/automation.js) provides 'refresh' and 'discovery' (automation-sources.js,
// with Undo for what discovery last added) and 'registration' (ui/screens/key-register.js).
import { h } from '../dom.js';
import { copyReport } from '../error-report.js';
import { setStatusItem } from '../statusline.js';
import { keyStatus, keyring, currentHandle } from '../screens/key-session.js';
import { brokerConfig } from '../screens/settings-store.js';
import { onCompanion, state as companionState } from '../companion-session.js';
import { companionChooser } from '../screens/road-kit.js';
import { testConnection } from '../../lib/protocol/transport.js';
import { services } from '../screens/node-services.js';
import { brokerProblem, brokerText } from '../screens/key-register.js';
import { everyMinute, fitTimes, stateMark } from './kit.js';
import { brokerReport, dataChanged, onDataChanged, onSources, reportBroker, source } from './sources.js';

export const id = 'status';
export const title = 'tile.status';

export const REFRESH_EVERY = 15 * 60000;

// The command server's word: never "not known yet" (W-28a).
export function brokerWord(ctx, st) {
  if (st.word) return ctx.t(st.word);   // the demo's own word (W-39e)
  if (st.state === 'ok') return ctx.t('tile.connected');
  if (st.state === 'alert') return ctx.t('tile.unreachable');
  if (st.state === 'running') return ctx.t('tile.connecting');
  return ctx.t('tile.notConnectedYet');
}

export function render(ctx) {
  const list = h('ul', { class: 'rows status-rows tile-fill' });
  let svcFor = null;      // [owner, services]
  let lastFleet = null;   // newest fleet.fetched among the devices (ms)
  let busy = new Set();

  const svc = async () => {
    const { publicKeyHex } = ctx.key.state();
    if (!publicKeyHex) return null;
    if (svcFor?.[0] !== publicKeyHex) svcFor = [publicKeyHex, await services(publicKeyHex)];
    return svcFor[1];
  };

  const readFleetAge = async () => {
    const s = await svc().catch(() => null);
    if (!s) { lastFleet = null; return; }
    const times = (await s.stores.devices.list()).map((d) => Date.parse(d.fleet?.fetched)).filter(Number.isFinite);
    lastFleet = times.length ? Math.max(...times) : null;
  };

  const act = (label, run, { disabled = false } = {}) => {
    const b = h('button', { type: 'button', class: 'link-button status-act', disabled: disabled || busy.has(label) }, label);
    b.addEventListener('click', async () => {
      busy.add(label);
      draw();
      try { await run(); } catch (e) { ctx.notify(e.message, { kind: 'error' }); } finally { busy.delete(label); draw(); }
    });
    return b;
  };

  // The word of a line that shows an error is a button: it copies every status line as text.
  const line = (name, state, word, action = null, detail = null) => {
    let mark = stateMark(ctx, state, word);
    if (state === 'alert') {
      mark = h('button', { type: 'button', class: 'link-button status-copy', title: ctx.t('report.hint') }, mark);
      mark.addEventListener('click', () => copyReport(ctx));
    }
    return h('li', { class: `row status-row${state === 'alert' ? ' alert' : ''}`, 'data-line': name, title: detail || null },
      h('span', { class: 'row-name' }, ctx.t(`tile.line.${name}`)), mark, action);
  };

  // The last and next run, shortened to fit the tile's width (W-33a, kit.js fitTimes).
  const clock = (st, fallbackWord) => {
    if (st.state === 'running') return ctx.t('tile.running');
    if (!st.last && !st.next) return fallbackWord;
    return fitTimes(ctx, st.last, st.next).el;
  };

  // The command server (W-28a): connecting…, connected, or unreachable and why; its host in the
  // tooltip. broker-source.js signs in by itself once the key is unlocked.
  function brokerLine() {
    const src = source('broker');
    const st = src?.state() || (() => {
      const r = brokerReport();
      return r ? { state: r.ok ? 'ok' : 'alert', at: r.at, detail: r.detail } : { state: 'running', at: null };
    })();
    const word = brokerWord(ctx, st);
    const hosts = st.hosts?.length ? st.hosts.join(', ') : null;
    setStatusItem('broker', { word, state: st.state === 'running' ? 'unknown' : st.state, href: '#tile-status-title', label: `${ctx.t('status.broker')}: ${word}` });
    const unlocked = ctx.key.state().status === 'unlocked';
    const why = st.state === 'alert' && st.detail ? brokerProblem(ctx.t, st.detail.replace(/^[^:]+: /, ''))?.text || st.detail : null;
    return line('broker', st.state, why ? `${word} (${why})` : word,
      unlocked && st.state !== 'running' && !st.word ? act(ctx.t('tile.test'), testBroker) : null,
      [hosts, st.detail ? brokerText(ctx.t, st.detail) : null].filter(Boolean).join(' · ') || null);
  }

  async function testBroker() {
    const s = await svc();
    const handle = currentHandle();
    if (!s || !handle) throw new Error(ctx.t('send.locked'));
    const steps = await testConnection({ config: brokerConfig(s.data.brokers, ''), handle });
    const bad = steps.find((x) => !x.ok);
    reportBroker({ ok: !bad, detail: bad ? `${bad.step}: ${bad.detail}` : steps.map((x) => x.detail).join(' · ') });
    ctx.announce(bad ? `${ctx.t('tile.unreached')}: ${bad.detail}` : ctx.t('tile.reached'));
  }

  function keyLine() {
    const { status } = ctx.key.state();
    const ks = keyStatus();
    // Locked or none: the unlock gate is in front of the page (W-28b).
    if (status !== 'unlocked') return line('key', status === 'locked' ? 'warn' : 'unknown', ctx.t(`key.${status}`));
    const after = ks.autoLockMinutes ? ctx.t('tile.locksAfter', { n: ks.autoLockMinutes }) : ctx.t('tile.locksOnClose');
    return line('key', 'ok', ctx.t('tile.unlockedShort'), act(ctx.t('key.lock'), async () => { await keyring()?.lock(); }), after);
  }

  function registrationLine() {
    const src = source('registration');
    if (!src) return line('registration', 'unknown', ctx.t('tile.notKnown'), h('a', { href: '#setup/key', class: 'status-act' }, ctx.t('tile.register')));
    const st = src.state();
    const word = st.word ? ctx.t(st.word) : st.state === 'ok' ? ctx.t('tile.registered') : st.state === 'running' ? ctx.t('tile.running')
      : st.state === 'alert' ? ctx.t('tile.notRegistered') : st.state === 'warn' ? ctx.t('tile.partly') : ctx.t('tile.notKnown');
    const unlocked = ctx.key.state().status === 'unlocked';
    return line('registration', st.state === 'running' ? 'unknown' : st.state, word,
      src.run && unlocked && st.state !== 'running' ? act(ctx.t(st.state === 'ok' ? 'tile.registerAgain' : 'tile.register'), () => src.run()) : null, st.detail);
  }

  // Not connected: the word itself opens the small chooser (USB, Bluetooth, and why one is
  // missing in this browser) instead of two buttons on the line (W-23a).
  function companionLine() {
    const c = companionState();
    if (c.status === 'connecting') return line('companion', 'unknown', ctx.t(c.phase === 'reconnecting' ? 'companion.reconnectingBrief' : 'companion.connecting'));
    const state = c.status === 'connected' ? 'ok' : c.status === 'error' ? 'alert' : 'unknown';
    const word = c.status === 'connected' ? c.name || ctx.t(`companion.kind.${c.kind}`)
      : c.status === 'error' ? ctx.t('tile.companionError') : ctx.t('tile.notConnected');
    const open = h('button', { type: 'button', class: 'link-button status-pick', 'aria-haspopup': 'dialog' }, stateMark(ctx, state, word));
    open.addEventListener('click', () => companionChooser(ctx));
    return h('li', { class: `row status-row${state === 'alert' ? ' alert' : ''}`, 'data-line': 'companion', title: c.errorKey ? ctx.t(c.errorKey) : c.error || null },
      h('span', { class: 'row-name' }, ctx.t('tile.line.companion')), open);
  }

  function refreshLine() {
    const src = source('refresh');
    const st = src?.state() || { state: lastFleet ? 'ok' : 'unknown', last: lastFleet, next: lastFleet ? lastFleet + REFRESH_EVERY : null };
    const run = src?.run ? () => src.run() : async () => {
      const s = await svc();
      if (!s) return;
      const r = await s.fleet();
      ctx.announce(ctx.t('nodes.fleetDone', { n: r.updated, failed: r.failed }));
      dataChanged('devices');
    };
    return line('refresh', st.state, clock(st, ctx.t('tile.notYet')), ctx.key.state().publicKeyHex ? act(ctx.t('tile.refreshNow'), run) : null, st.detail);
  }

  function discoveryLine() {
    const src = source('discovery');
    if (!src) return line('discovery', 'unknown', ctx.t('tile.notRunHere'), h('a', { href: '#nodes', class: 'status-act' }, ctx.t('tile.lookNow')));
    const st = src.state();
    const acts = [src.run && ctx.key.state().status === 'unlocked' ? act(ctx.t('tile.lookNow'), () => src.run()) : null,
      src.undo && st.canUndo ? act(ctx.t('disc.undo'), async () => { await src.undo(); ctx.announce(ctx.t('disc.undone')); }) : null].filter(Boolean);
    return line('discovery', st.state, clock(st, ctx.t('tile.notYet')), acts.length ? h('span', { class: 'status-acts' }, acts) : null, st.detail);
  }

  function draw() {
    list.replaceChildren(brokerLine(), keyLine(), registrationLine(), companionLine(), refreshLine(), discoveryLine());
  }

  // Each source's own changes, re-wired when a source is provided or withdrawn.
  let unsub = [];
  const wire = () => {
    for (const u of unsub) u();
    unsub = ['broker', 'registration', 'refresh', 'discovery'].map((n) => source(n)?.on?.(draw)).filter(Boolean);
    draw();
  };
  const tie = (u) => ctx.signal.addEventListener('abort', u, { once: true });
  tie(onSources(wire));
  tie(() => { for (const u of unsub) u(); });
  tie(ctx.key.on(() => { svcFor = null; readFleetAge().then(draw); }));
  tie(onCompanion(draw));
  tie(onDataChanged(() => readFleetAge().then(draw)));
  everyMinute(ctx.signal, draw);
  wire();
  readFleetAge().then(draw).catch(() => {});
  return list;
}
