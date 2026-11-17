// STATUS (W-20c, W-20e): the states that gate everything, one line each, and each line a button
// where it can act: broker (Test), key (Unlock / Lock), registration (Register), companion
// (Connect / Disconnect), the Beacon status refresh (Refresh now) and discovery (Look now). It
// also sets the header's `broker` item.
//
// Registration, refresh and discovery are other streams' work (automatic registration, W-20e's
// 15-minute Beacon refresh, W-20a's discovery). They plug in through ui/tiles/sources.js
// (provideSource); until one is provided its line here is a stand-in:
//   broker        the last connection this page made (a send or Test: reportBroker)
//   registration  "not known": Register opens Setup's key tab, where it is done today
//   refresh       the newest Beacon read stored on a device, the next due 15 minutes after it;
//                 Refresh now reads Beacon (no transmission)
//   discovery     "not run here": Look now opens today's discovery form
// The page's automation (ui/automation.js) provides 'refresh' and 'discovery' (automation-sources.js,
// with Undo for what discovery last added); registration by itself provides 'registration'.
import { h } from '../dom.js';
import { setStatusItem } from '../statusline.js';
import { keyStatus, keyring, currentHandle } from '../screens/key-session.js';
import { brokerConfig } from '../screens/settings-store.js';
import { connect, disconnect, onCompanion, state as companionState, support } from '../companion-session.js';
import { testConnection } from '../../lib/protocol/transport.js';
import { services } from '../screens/node-services.js';
import { everyMinute, shortAge, shortUntil, stateMark } from './kit.js';
import { brokerReport, dataChanged, onDataChanged, onSources, reportBroker, source } from './sources.js';

export const id = 'status';
export const title = 'tile.status';

export const REFRESH_EVERY = 15 * 60000;

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

  const line = (name, state, word, action = null, detail = null) => h('li', { class: `row status-row${state === 'alert' ? ' alert' : ''}`, 'data-line': name, title: detail || null },
    h('span', { class: 'row-name' }, ctx.t(`tile.line.${name}`)), stateMark(ctx, state, word), action);

  const clock = (st, fallbackWord) => {
    const parts = [];
    if (st.state === 'running') return ctx.t('tile.running');
    if (st.last) parts.push(ctx.t('tile.ago', { age: shortAge(ctx, st.last) }));
    if (st.next) parts.push(ctx.t('tile.next', { when: shortUntil(ctx, st.next) }));
    return parts.join(', ') || fallbackWord;
  };

  function brokerLine() {
    const src = source('broker');
    const st = src?.state() || (() => {
      const r = brokerReport();
      return r ? { state: r.ok ? 'ok' : 'alert', last: r.at, detail: r.detail } : { state: 'unknown', last: null };
    })();
    const word = st.state === 'ok' ? ctx.t('tile.reached') : st.state === 'alert' ? ctx.t('tile.unreached') : ctx.t('status.notYet');
    setStatusItem('broker', { word, state: st.state === 'running' ? 'unknown' : st.state, href: '#tile-status-title', label: `${ctx.t('status.broker')}: ${word}` });
    const unlocked = ctx.key.state().status === 'unlocked';
    return line('broker', st.state, st.last ? `${word} ${shortAge(ctx, st.last)}` : word,
      unlocked ? act(ctx.t('tile.test'), testBroker) : null, st.detail);
  }

  async function testBroker() {
    const s = await svc();
    const handle = currentHandle();
    if (!s || !handle) throw new Error(ctx.t('send.locked'));
    const region = (await s.stores.devices.list())[0]?.region || '';
    const steps = await testConnection({ config: brokerConfig(s.data.brokers, region), handle });
    const bad = steps.find((x) => !x.ok);
    reportBroker({ ok: !bad, detail: bad ? `${bad.step}: ${bad.detail}` : steps.map((x) => x.detail).join(' · ') });
    ctx.announce(bad ? `${ctx.t('tile.unreached')}: ${bad.detail}` : ctx.t('tile.reached'));
  }

  function keyLine() {
    const { status } = ctx.key.state();
    const ks = keyStatus();
    if (status === 'none') return line('key', 'unknown', ctx.t('key.none'), h('a', { href: '#unlock', class: 'status-act' }, ctx.t('tile.makeKey')));
    if (status === 'locked') return line('key', 'warn', ctx.t('key.locked'), h('a', { href: '#unlock', class: 'status-act' }, ctx.t('key.unlock')));
    const after = ks.autoLockMinutes ? ctx.t('tile.locksAfter', { n: ks.autoLockMinutes }) : ctx.t('tile.locksOnClose');
    return line('key', 'ok', ctx.t('tile.unlockedShort'), act(ctx.t('key.lock'), async () => { await keyring()?.lock(); }), after);
  }

  function registrationLine() {
    const src = source('registration');
    if (!src) return line('registration', 'unknown', ctx.t('tile.notKnown'), h('a', { href: '#setup/key', class: 'status-act' }, ctx.t('tile.register')));
    const st = src.state();
    const word = st.state === 'ok' ? ctx.t('tile.registered') : st.state === 'running' ? ctx.t('tile.running')
      : st.state === 'alert' ? ctx.t('tile.notRegistered') : ctx.t('tile.notKnown');
    return line('registration', st.state === 'running' ? 'unknown' : st.state, word,
      src.run && st.state !== 'ok' ? act(ctx.t('tile.register'), () => src.run()) : null, st.detail);
  }

  function companionLine() {
    const c = companionState();
    const can = support();
    if (c.status === 'connected') return line('companion', 'ok', c.name || ctx.t(`companion.kind.${c.kind}`), act(ctx.t('companion.disconnect'), () => disconnect()));
    if (c.status === 'connecting') return line('companion', 'unknown', ctx.t('companion.connecting'));
    const buttons = [can.bluetooth ? act(ctx.t('companion.bluetooth'), () => connect('bluetooth')) : null,
      can.usb ? act(ctx.t('companion.usb'), () => connect('usb')) : null].filter(Boolean);
    return line('companion', c.status === 'error' ? 'alert' : 'unknown',
      c.status === 'error' ? ctx.t('tile.companionError') : ctx.t('tile.none'),
      buttons.length ? h('span', { class: 'status-acts' }, buttons) : h('span', { class: 'muted' }, ctx.t('tile.noRadioHere')), c.error || null);
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
    if (st.needsArea) return line('discovery', 'warn', ctx.t('disc.needsArea'), h('a', { href: '#setup/area', class: 'status-act' }, ctx.t('tile.chooseArea')));
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
