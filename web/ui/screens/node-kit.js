// Shared by the node, send, group, set and history screens: their stylesheet, the
// key gate, ages, a result in words, the confirmation dialog, a progress line and downloads.
import { h } from '../dom.js';
import { codeHelp, codeName } from '../../lib/protocol/results.js';
import { batteryKnown, batteryReading, NO_READING, shortVersion, voltsText } from '../../lib/jobs/overview.js';
import { services } from './node-services.js';
import { unlockHash } from './key-session.js';

// The screens' stylesheet, linked once (style-src 'self'; no inline style anywhere).
export function useStyles() {
  if (document.getElementById('node-kit-css')) return;
  document.head.append(h('link', { id: 'node-kit-css', rel: 'stylesheet', href: new URL('./node-kit.css', import.meta.url).href }));
}

// replaceChildren with h()'s rules: arrays flattened, null and false left out.
export function put(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : String(c))));
}

// The section every screen returns: an <h1> that labels it, then the body (filled later).
export function screen(id, title, ...children) {
  useStyles();
  return h('section', { 'aria-labelledby': `${id}-title`, class: `scr scr-${id}` },
    h('h1', { id: `${id}-title` }, title), ...children);
}

// Where an unlock prompt leads: the unlock screen, then back to this screen.
export const unlockHere = (ctx) => unlockHash([ctx.route, ...ctx.args.map(encodeURIComponent)].join('/'));

// "The key is locked.": only when it locked during a job; the page's unlock gate (W-28b) is then
// in front, so there is no link of its own.
export function lockedNote(ctx) {
  return [ctx.t('send.locked')];
}

// The key the screen works for, or a paragraph saying there is none. Locked is fine for
// reading; sending says so itself.
export function keyGate(ctx) {
  const { status, publicKeyHex } = ctx.key.state();
  if (status === 'none' || !publicKeyHex) {
    return { owner: null, note: h('p', {}, ctx.t('node.noKey'), ' ', h('a', { href: unlockHere(ctx) }, ctx.t('node.noKeyLink'))) };
  }
  return { owner: publicKeyHex, locked: status === 'locked', note: null };
}

// Load the services for the screen's key into `body`, then call fill(svc). Errors are said in
// the body, not thrown.
export function withServices(ctx, body, fill) {
  const gate = keyGate(ctx);
  if (!gate.owner) { put(body, gate.note); return; }
  put(body, h('p', { class: 'muted', role: 'status' }, ctx.t('node.loading')));
  services(gate.owner)
    .then((svc) => { if (!ctx.signal.aborted) return fill(svc, gate); return null; })
    .catch((e) => { if (!ctx.signal.aborted) put(body, h('p', { class: 'err' }, e.message)); });
}

// "3 h ago", "just now"; '' for no time. Exact time in the title attribute of when().
export function ago(ctx, iso, now = Date.now()) {
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const secs = Math.round((at - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(ctx.lang, { numeric: 'auto', style: 'short' });
  const abs = Math.abs(secs);
  if (abs < 45) return ctx.t('node.justNow');
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), 'hour');
  return rtf.format(Math.round(secs / 86400), 'day');
}

export function when(ctx, iso) {
  if (!iso) return h('span', { class: 'muted' }, ctx.t('node.never'));
  const at = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  return h('time', { datetime: at.toISOString(), title: at.toLocaleString(ctx.lang) }, ago(ctx, at.getTime()));
}

// What a result means, in words: { kind, text, help }. kind is ok | refused | silent | forged.
// Silence over the mesh (road 'mesh') has its own reasons, none of them a refusal. Through a
// relay (`relay`: { status }) what came back without the node's answer is the relay's status in
// the spec's words: never "refused", because the node itself has said nothing. `advice` is what
// lib/jobs/silence.js had to say of this send, kept on its history event: after a silence the
// suggestion of a flood, and on a `get cmd` answer that the node refused for lack of airtime.
// A read that answers with a bare code: what the value means, in words (W-54). `get <setting>`
// and its answer -> the words, or '' when the setting or the value is not in the list.
export const VALUE_WORDS = Object.freeze({
  'path.hash.mode': ['0', '1', '2'],
  'loop.detect': ['off', 'minimal', 'moderate', 'strict'],
});
export function valueWords(t, command, reply) {
  const m = /^get\s+(\S+)$/i.exec(String(command || '').trim());
  const setting = m ? m[1].toLowerCase() : null;
  const value = String(reply || '').replace(/^>\s*/, '').trim().toLowerCase();
  return setting && VALUE_WORDS[setting]?.includes(value) ? t(`value.${setting}.${value}`) : '';
}

export function explain(ctx, svc, result, device = null, road = 'mqtt', relay = null, advice = null) {
  // The flood is suggested by the names of the controls that ask for one; nothing is switched or sent.
  const controls = () => ({ road: ctx.t('road.legend'), relay: ctx.t('road.relay'), route: ctx.t('road.relayRoute'), flood: ctx.t('road.route.flood') });
  const said = (word) => (!advice?.includes(word) ? '' : ` ${word === 'flood' ? ctx.t(`road.adviceFlood.${road}`, controls()) : ctx.t('road.adviceRefused')}`);
  const silent = () => `${ctx.t('road.adviceSilent')}${said('flood')}`;
  if (!result && road === 'relay') {
    const status = relay?.status ?? null;
    return { kind: 'silent', text: ctx.t('send.res.silent'), help: relayHelp(ctx, svc, status) + (status === 'no-answer' ? ` ${silent()}` : '') };
  }
  if (!result) {
    if (road === 'mesh') return { kind: 'silent', text: ctx.t('send.res.silent'), help: `${ctx.t('road.silentMesh')} ${silent()}` };
    // Silent over MQTT while Beacon heard its radio within the hour: the node is up but off the
    // command server. A clock that fell behind does that (its logins are refused as expired).
    const seen = Date.parse(device?.fleet?.seen || '');
    const onAir = Number.isFinite(seen) && Date.now() - seen < 3600000 && !svc.rules.deviceMeshOnly(device);
    return { kind: 'silent', text: ctx.t('send.res.silent'), help: `${ctx.t('send.res.silentHelp')}${onAir ? ` ${ctx.t('send.res.clockHint')}` : ''}` };
  }
  if (result.verified === false) return { kind: 'forged', text: ctx.t('send.res.forged'), help: ctx.t('send.res.forgedHelp') };
  const sig = result.verified ? ctx.t('send.res.signed') : ctx.t('send.res.unsigned');
  if (result.ok) {
    const words = valueWords(ctx.t, result.command, result.reply);
    return { kind: 'ok', text: `${result.reply || 'OK'}${words ? ` · ${words}` : ''}`, help: sig + said('refused') };
  }
  const name = codeName(svc.data.results, result.code);
  let help = codeHelp(svc.data.results, result.code) || ctx.t('send.res.noHelp');
  // not-allowed: say whether the node's firmware (its own `ver`, else what Beacon reports) is
  // older than the command needs (W-23g: an ar-10 node refuses `ver`, which came in ar-11).
  const version = device?.ver || device?.fleet?.firmware || null;
  if (result.code === 14 && result.command) {
    const needs = svc.rules.needs(result.command);
    if (version && !svc.rules.admits(version, result.command)) {
      const short = shortVersion(svc.rules, version);
      return { kind: 'refused', text: ctx.t('send.res.tooOld', { name, version: short, needs: needs || '?' }),
        help: ctx.t('send.res.tooOldHelp', { version: short, command: result.command, needs: needs || '?' }) };
    }
    if (version) help += ` ${ctx.t('send.res.finding')}`;
    else if (needs) help += ` ${ctx.t('send.res.maybeOld', { needs })}`;
  }
  return { kind: 'refused', text: name, help };
}

// What a relay's status means (results.json's `forward`, Swedish where the spec has it). No
// status at all is a relay that said nothing; `answered` without a result is an answer that
// did not open.
function relayHelp(ctx, svc, status) {
  const f = svc.data.results.forward;
  if (status === null) return ctx.t('road.relaySilent');
  if (status === 'answered') return ctx.t('road.relayUnread');
  // lou-21's refusals of a guest forward (TODO(L21-G2): results.json does not carry them yet).
  if (['guest-cap', 'guests-full', 'target-cap'].includes(status)) return ctx.t(`road.guestRefused.${status}`);
  const code = Object.keys(f.statuses).find((k) => f.statuses[k] === status);
  return (ctx.lang === 'sv' && f.help_sv?.[code]) || f.help[code] || ctx.t('road.relayStatus', { status });
}

// The same for a stored history event (no Result object).
export function explainEvent(ctx, svc, e, device = null) {
  if (e.code === null && e.node === null) return { kind: 'summary', text: e.note, help: '' };
  if (e.verified === false) return explain(ctx, svc, { verified: false });
  if (e.code === null) return explain(ctx, svc, null, null, e.road, e.relay, e.advice);
  return explain(ctx, svc, { code: e.code, reply: e.reply, verified: e.verified, ok: e.code === 0, command: e.command }, device, e.road, null, e.advice);
}

// The words under a result's tag: the command (when given), the reply for an ok, the code
// name for a refusal, and what the outcome means. Returns [text, help] for .res-text/.res-help.
export function resultBody(x, command = null) {
  const cmd = command ? h('code', { class: 'res-cmd' }, command) : null;
  if (x.kind === 'ok') return [[cmd, h('code', { class: 'reply' }, x.text)], x.help];
  if (x.kind === 'refused') return [[cmd, h('span', {}, x.text)], x.help];
  return [[cmd, h('span', {}, x.help)], null];
}

export function outcomeTag(ctx, kind) {
  return h('span', { class: `tag tag-${kind}` }, ctx.t(`history.kind.${kind}`));
}

// A modal confirmation. Resolves true only for the confirm button. `lines` are paragraphs.
export function confirm(ctx, { title, lines = [], confirmLabel, danger = false }) {
  useStyles();
  return new Promise((resolve) => {
    const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    const cancel = h('button', { type: 'button', class: 'tool', autofocus: true }, ctx.t('node.cancel'));
    const ok = h('button', { type: 'button', class: danger ? 'button button-danger' : 'button' }, confirmLabel);
    const dialog = h('dialog', { class: 'dlg', 'aria-labelledby': id, closedby: 'any' },
      h('h2', { id }, title),
      ...lines.map((l) => (l instanceof Node ? l : h('p', {}, l))),
      h('div', { class: 'row-end' }, cancel, ok));
    cancel.addEventListener('click', () => dialog.close('cancel'));
    ok.addEventListener('click', () => dialog.close('ok'));
    dialog.addEventListener('close', () => {
      const yes = dialog.returnValue === 'ok';
      dialog.returnValue = '';
      dialog.remove();
      resolve(yes);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// A <progress> with a line of text, updated by set(fraction or null, text).
export function progressLine() {
  const bar = h('progress', { max: '1' });
  const text = h('span', {});
  const el = h('div', { class: 'progress', role: 'status' }, bar, text);
  return {
    el,
    set(fraction, line) {
      if (fraction === null) bar.removeAttribute('value'); else bar.value = Math.max(0, Math.min(1, fraction));
      text.textContent = line;
    },
  };
}

// Save `text` as a file named `name`.
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A device's display name.
export const nameOf = (d) => d.name || d.node;

// A labelled field: <label> + control (+ hint).
export function field(label, control, hint = null) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control,
    hint ? h('p', { class: 'hint-line', id: hintId }, hint) : null);
}

// Sort helper for names in the page's language.
export const byName = (lang) => (a, b) => nameOf(a).localeCompare(nameOf(b), lang);

// The newest battery reading in words, with its age and where it came from (L21-D8): "3.71 V,
// 9 hr. ago, heard by DEMO-Ekbacken" (the announce of a node without Wi-Fi, caught by one of your
// Observer nodes) or "4.01 V, 30 min. ago, from Beacon". '' when there is none.
export function batteryWords(ctx, device, now = Date.now()) {
  const b = batteryReading(device);
  if (!b) return '';
  return [voltsText(b.mv), b.at === null ? null : ago(ctx, b.at, now),
    b.source === 'heard' ? ctx.t('battery.heardBy', { name: b.byName || b.by }) : ctx.t('battery.fromBeacon')].filter(Boolean).join(', ');
}

// "heard by DEMO-Ekbacken 9 hr. ago" for a node without Wi-Fi whose announce one of your Observer
// nodes caught (L21-D8); '' for any other. The time is the catching node's clock, or the time this
// page read it when that clock was unset (the tooltip says so).
export function heardWords(ctx, device, now = Date.now()) {
  const x = device?.heard;
  if (!x?.at) return '';
  return ctx.t('heard.byAgo', { name: x.byName || x.by, age: ago(ctx, x.at, now) });
}

// The battery for a screen: the newest reading in words, low marked as such, or "NA".
export function batteryOf(ctx, device, { now = Date.now(), lowMv = null } = {}) {
  const b = batteryReading(device);
  if (!b) return volts(ctx.t, null);
  const low = lowMv !== null && b.mv < lowMv;
  return h('span', { class: low ? 'warn-text' : '' }, batteryWords(ctx, device, now), low ? ` ${ctx.t('nodes.low')}` : '');
}

// "heard by ..." as an element with the reading's details for its tooltip, or null.
export function heardOf(ctx, device, now = Date.now()) {
  const words = heardWords(ctx, device, now);
  if (!words) return null;
  const x = device.heard;
  const tip = [ctx.t('heard.tip', { snr: x.snr, hops: x.hops }), x.atRead ? ctx.t('heard.atRead') : null].filter(Boolean).join(' ');
  return h('span', { class: 'heard-by', title: tip }, words);
}

// A battery reading for the screen (W-26j): "3.98 V", or "NA" with "Not available" as its tooltip
// and as what a screen reader says, when the node has no battery or reports 0 mV.
export function volts(t, mv) {
  if (batteryKnown(mv)) return voltsText(mv);
  const words = t('battery.na');
  // A span, not an <abbr>: no dotted underline (W-33b); the tooltip and the spoken words stay.
  return h('span', { class: 'na', title: words }, h('span', { 'aria-hidden': 'true' }, NO_READING), h('span', { class: 'visually-hidden' }, words));
}
