// Shared by the node, send, group, set and history screens: their stylesheet, the
// key gate, ages, a result in words, the confirmation dialog, a progress line and downloads.
import { h } from '../dom.js';
import { codeHelp, codeName } from '../../lib/protocol/results.js';
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

// "The key is locked." with a link that unlocks and comes back.
export function lockedNote(ctx) {
  return [ctx.t('send.locked'), ' ', h('a', { href: unlockHere(ctx) }, ctx.t('send.unlockLink'))];
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
// Silence over the mesh (road 'mesh') has its own reasons, none of them a refusal.
export function explain(ctx, svc, result, device = null, road = 'mqtt') {
  if (!result) return { kind: 'silent', text: ctx.t('send.res.silent'), help: ctx.t(road === 'mesh' ? 'road.silentMesh' : 'send.res.silentHelp') };
  if (result.verified === false) return { kind: 'forged', text: ctx.t('send.res.forged'), help: ctx.t('send.res.forgedHelp') };
  const sig = result.verified ? ctx.t('send.res.signed') : ctx.t('send.res.unsigned');
  if (result.ok) return { kind: 'ok', text: result.reply || 'OK', help: sig };
  const name = codeName(svc.data.results, result.code);
  let help = codeHelp(svc.data.results, result.code) || ctx.t('send.res.noHelp');
  if (result.code === 14 && device?.ver && svc.rules.admits(device.ver, result.command)) help += ` ${ctx.t('send.res.finding')}`;
  return { kind: 'refused', text: name, help };
}

// The same for a stored history event (no Result object).
export function explainEvent(ctx, svc, e) {
  if (e.code === null && e.node === null) return { kind: 'summary', text: e.note, help: '' };
  if (e.verified === false) return explain(ctx, svc, { verified: false });
  if (e.code === null) return explain(ctx, svc, null, null, e.road);
  return explain(ctx, svc, { code: e.code, reply: e.reply, verified: e.verified, ok: e.code === 0, command: e.command });
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
