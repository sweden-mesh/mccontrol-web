// Setup's Key tab (W-5, W-20d): the public key, copy and QR code, the broker registration (it
// runs by itself, key-register.js), lock and auto-lock, the copies the owner may keep
// (the backup file, or the private key shown after the passphrase) and the browser's keeping of
// it, the passphrase, fingerprint unlock, replacing the key on the nodes (key-rekey.js), and
// replacing the key in this browser outright behind a dialog that says what it costs. Keeping a copy is the owner's job (operator 2026-11-17).
import { h } from '../dom.js';
import { download } from './node-kit.js';
import { copyButton, errorLine, groupedHex, passField, qrSvg, showPassphrases, useStyles } from './key-kit.js';
import { currentHandle, keyring, keyStatus, onKeyStatus } from './key-session.js';
import { isDemo } from '../demo/mode.js';
import { passProblem, MIN } from './unlock.js';
import { registerNow, registration, onRegistration, registrationText } from './key-register.js';
import { AUTO_LOCK_CHOICES } from '../../lib/key/keyring.js';
import { rekeyBlock } from './key-rekey.js';

export const REG_GLYPH = Object.freeze({ ok: '●', failed: '✕', running: '…', none: '?' });

export const route = 'key';
export const title = 'nav.key';

// How long the private key stays on screen once shown.
export const REVEAL_MS = 60000;

// The shown private key: show(hex) holds it and hides it again after `ms`; hide() drops it and
// calls onHide once. value() is the hex while shown, else null. copy() is the hex for the Copy
// button and remembers it was copied, so hiding also empties the clipboard (W-12): the key is not
// left there for the next paste. Best effort: a browser without focus may refuse the write.
export function revealer(onHide, { ms = REVEAL_MS, timers = globalThis, clipboard = () => globalThis.navigator?.clipboard } = {}) {
  let value = null;
  let timer = null;
  let copied = false;
  const hide = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (copied) {
      copied = false;
      try { Promise.resolve(clipboard()?.writeText('')).catch(() => {}); } catch { /* no clipboard */ }
    }
    if (value === null) return;
    value = null;
    onHide();
  };
  return {
    show(hex) { hide(); value = hex; timer = timers.setTimeout(hide, ms); },
    hide,
    value: () => value,
    copy() { if (value !== null) copied = true; return value ?? ''; },
  };
}

export const autoLockText = (t, minutes) => (minutes === null ? t('key.autolock.tab') : t(`key.autolock.${minutes}`));

// Auto-lock, kept with the key: radio buttons that save at once.
function autoLockChoice(ctx, s) {
  const { t } = ctx;
  const saved = h('p', { role: 'status', class: 'hint-line' });
  const fieldset = h('fieldset', { class: 'choice' }, h('legend', {}, t('key.autolock')),
    AUTO_LOCK_CHOICES.map((m) => {
      const input = h('input', { type: 'radio', name: 'autolock', value: String(m), checked: m === s.autoLockMinutes });
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        try {
          await keyring().setAutoLock(m);
          saved.textContent = t('settings.saved');
        } catch (ex) { saved.textContent = ex.message; }
      });
      return h('label', {}, input, ' ', autoLockText(t, m));
    }));
  return h('div', { class: 'stack' }, fieldset, h('p', { class: 'hint-line' }, t('settings.autoLockHint')), saved);
}

const block = (id, heading, ...children) => h('section', { class: 'key-block', 'aria-labelledby': id },
  h('h3', { id }, heading), ...children);

function busy(button, on) { button.disabled = on; button.setAttribute('aria-busy', String(on)); }

export function render(ctx) {
  useStyles();
  const { t } = ctx;
  const body = h('div', {});
  const section = h('section', { 'aria-labelledby': 'key-title', class: 'scr key-screen' },
    h('h2', { id: 'key-title' }, t('setup.tab.key')), body);
  const ring = keyring();
  let showQr = false;
  let seedSlot = null;            // where the shown private key is, in the current draw
  let seedButton = null;          // its Show button, which gets focus back when it hides
  const seed = revealer(() => {
    if (!seedSlot) return;
    const refocus = seedSlot.contains(document.activeElement);
    seedSlot.replaceChildren();
    if (refocus) seedButton?.focus();
  });

  const draw = (s) => {
    seed.hide();
    if (!ring || !s.exists) {
      body.replaceChildren(h('p', {}, t('keyscreen.none')), h('p', {}, h('a', { class: 'button', href: '#/unlock' }, t('keyscreen.toStart'))));
      return;
    }
    if (isDemo()) { body.replaceChildren(h('p', { class: 'demo-note' }, t('demo.keyNote')), publicBlock(s), rekeyBlock(ctx)); return; }
    // While the key is being replaced on the nodes, replacing it outright would drop the next key.
    const outright = replaceBlock();
    outright.hidden = Boolean(s.rekey);
    body.replaceChildren(...[publicBlock(s), registerBlock(), lockBlock(s), backupBlock(s), passBlock(s), fingerprintBlock(s),
      rekeyBlock(ctx, { onRound: (active) => { outright.hidden = active; } }), outright].filter(Boolean),
      h('p', {}, h('a', { href: '#help/signing' }, t('keyscreen.helpLink'))));
  };

  function publicBlock(s) {
    const qrSlot = h('div', { class: 'qr-slot', id: 'key-qr' });
    const qrButton = h('button', { type: 'button', class: 'tool', 'aria-expanded': String(showQr), 'aria-controls': 'key-qr' });
    const sync = () => {
      qrButton.textContent = t(showQr ? 'keyscreen.qrHide' : 'keyscreen.qrShow');
      qrButton.setAttribute('aria-expanded', String(showQr));
      qrSlot.replaceChildren(...(showQr ? [qrSvg(s.publicKeyHex, t('keyscreen.qrLabel')), h('p', { class: 'hint-line' }, t('keyscreen.qrHint'))] : []));
    };
    qrButton.addEventListener('click', () => { showQr = !showQr; sync(); });
    sync();
    return block('pub-title', t('keyscreen.public'),
      h('p', {}, t('keyscreen.publicBody')),
      h('p', { class: 'pubkey' }, h('code', { translate: 'no' }, groupedHex(s.publicKeyHex))),
      h('div', { class: 'row wrap' }, copyButton(t, s.publicKeyHex), qrButton),
      qrSlot,
      h('p', {}, h('a', { href: '#setup/node' }, t('keyscreen.toSetup'))));
  }

  function lockBlock(s) {
    const lock = h('button', { type: 'button', class: 'button' }, t('keyscreen.lockNow'));
    lock.addEventListener('click', () => { ring.lock(); ctx.announce(t('keyscreen.lockedNow')); });
    return block('lock-title', t('keyscreen.lock'),
      h('p', {}, t(s.locked ? 'keyscreen.isLocked' : 'keyscreen.isUnlocked')),
      s.locked ? null : h('div', { class: 'row' }, lock),
      autoLockChoice(ctx, s));
  }

  function backupBlock(s) {
    const when = s.backup ? new Date(s.backup.at).toLocaleString(ctx.lang, { dateStyle: 'medium', timeStyle: 'short' }) : null;
    const state = s.backup
      ? h('p', {}, t(s.backup.form === 'file' ? 'key.backup.done' : 'keyscreen.backupConfirmed', { at: when }))
      : null;
    const persist = s.persist?.granted ? h('p', { class: 'muted' }, t('key.persist.granted')) : (() => {
      const ask = h('button', { type: 'button', class: 'link-button' }, t('keyscreen.askKeep'));
      ask.addEventListener('click', async () => {
        const granted = await ring.requestPersistence().catch(() => false);
        ctx.announce(t(granted ? 'key.persist.granted' : 'keyscreen.keepRefused'));
      });
      return h('p', { class: 'muted' }, t('key.persist.denied'), ' ', ask);
    })();
    const err = errorLine();
    const pass = passField(t, { label: t('unlock.pass'), autocomplete: 'current-password', name: 'passphrase', hint: t('unlock.backupNeedsPass') });
    const go = h('button', { type: 'submit', class: 'button' }, t('unlock.download'));
    const form = h('form', { class: 'stack', novalidate: true }, pass.el, h('div', { class: 'row' }, go), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pass.input.value) { err.textContent = t('unlock.problem.empty'); pass.input.focus(); return; }
      busy(go, true);
      try {
        const file = await ring.exportBackup(pass.input.value);
        download(file.filename, file.text, 'application/json');
        pass.input.value = '';
        err.textContent = '';
        ctx.announce(t('unlock.savedAs', { file: file.filename }));
      } catch { err.textContent = t('unlock.wrong'); } finally { busy(go, false); }
    });
    return block('backup-title', t('keyscreen.backup'),
      state,
      persist,
      h('details', { class: 'block' }, h('summary', {}, t('unlock.download')), form),
      seedDetails());
  }

  // The private key as text, for a password manager: only after the passphrase, hidden again
  // after REVEAL_MS, on a lock, on a redraw and when the screen is left.
  function seedDetails() {
    const err = errorLine();
    const pass = passField(t, { label: t('unlock.pass'), autocomplete: 'current-password', name: 'passphrase' });
    const go = h('button', { type: 'submit', class: 'button' }, t('keyscreen.seedShow'));
    const form = h('form', { class: 'stack', novalidate: true }, h('p', {}, t('keyscreen.seedBody')), pass.el, h('div', { class: 'row' }, go), err);
    const slot = h('div', { class: 'stack' });
    seedSlot = slot;
    seedButton = go;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pass.input.value) { err.textContent = t('unlock.problem.empty'); pass.input.focus(); return; }
      busy(go, true);
      try {
        seed.show(await ring.revealSeed(pass.input.value));
        pass.input.value = '';
        err.textContent = '';
        const hide = h('button', { type: 'button', class: 'tool' }, t('keyscreen.seedHide'));
        hide.addEventListener('click', () => seed.hide());
        slot.replaceChildren(
          h('p', { class: 'warn-text' }, t('keyscreen.seedWarn')),
          h('p', { class: 'pubkey' }, h('code', { translate: 'no' }, seed.value())),
          h('div', { class: 'row wrap' }, copyButton(t, () => seed.copy(), t('keyscreen.seedCopy')), hide),
          h('p', { class: 'hint-line' }, t('keyscreen.seedWhen')));
        hide.focus();
      } catch { err.textContent = t('unlock.wrong'); } finally { busy(go, false); }
    });
    return h('details', { class: 'block' }, h('summary', {}, t('keyscreen.seed')), form, slot);
  }

  function passBlock() {
    const old = passField(t, { label: t('keyscreen.oldPass'), autocomplete: 'current-password', name: 'passphrase', toggle: false });
    const first = passField(t, { label: t('keyscreen.newPass'), autocomplete: 'new-password', name: 'new-passphrase', hint: t('unlock.passHint', { min: MIN }), toggle: false });
    const second = passField(t, { label: t('unlock.passAgain'), autocomplete: 'new-password', name: 'new-passphrase-again', toggle: false });
    const err = errorLine();
    const go = h('button', { type: 'submit', class: 'button' }, t('keyscreen.changePass'));
    const form = h('form', { class: 'stack', novalidate: true }, old.el, first.el, second.el, showPassphrases(t, [old, first, second]),
      h('p', { class: 'muted' }, t('keyscreen.changePassNote')), h('div', { class: 'row' }, go), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = passProblem(first.input.value, second.input.value);
      if (problem) { err.textContent = t(`unlock.problem.${problem}`, { min: MIN }); (problem === 'short' ? first : second).input.focus(); return; }
      busy(go, true);
      try {
        await ring.changePassphrase(old.input.value, first.input.value);
        for (const f of [old, first, second]) f.input.value = '';
        err.textContent = '';
        ctx.notify(t('keyscreen.passChanged'));
      } catch { err.textContent = t('unlock.wrong'); old.input.focus(); } finally { busy(go, false); }
    });
    return block('pass-title', t('keyscreen.passphrase'),
      h('details', { class: 'block' }, h('summary', {}, t('keyscreen.changePass')), form));
  }

  function fingerprintBlock(s) {
    if (!globalThis.PublicKeyCredential) return null;
    const err = errorLine();
    if (s.fingerprint) {
      const off = h('button', { type: 'button', class: 'tool' }, t('key.fingerprint.disable'));
      off.addEventListener('click', async () => { await ring.disableFingerprint(); ctx.announce(t('keyscreen.fingerprintOff')); });
      return block('fp-title', t('keyscreen.fingerprint'), h('p', {}, t('keyscreen.fingerprintOn')), h('div', { class: 'row' }, off));
    }
    const pass = passField(t, { label: t('unlock.pass'), autocomplete: 'current-password', name: 'passphrase' });
    const go = h('button', { type: 'submit', class: 'button' }, t('keyscreen.fingerprintTry'));
    const form = h('form', { class: 'stack', novalidate: true }, pass.el, h('p', { class: 'muted' }, t('keyscreen.fingerprintHow')),
      h('div', { class: 'row' }, go), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      busy(go, true);
      err.textContent = '';
      try {
        // The keyring offers it only after a real sign-in returned PRF bytes and a second one
        // opened the wrap; anything less is an error here, and nothing is stored.
        await ring.enableFingerprint(pass.input.value);
        ctx.notify(t('keyscreen.fingerprintOn'));
      } catch (ex) {
        err.textContent = /passphrase is wrong/.test(ex.message) ? t('unlock.wrong') : t('keyscreen.fingerprintNo', { reason: ex.message });
      } finally { busy(go, false); }
    });
    return block('fp-title', t('keyscreen.fingerprint'), h('p', {}, t('keyscreen.fingerprintBody')),
      h('details', { class: 'block' }, h('summary', {}, t('key.fingerprint.enable')), form));
  }

  // Registration runs by itself (key-register.js); this says how it went and offers it again.
  function registerBlock() {
    const lines = h('ul', { class: 'reg-lines' });
    const again = h('button', { type: 'button', class: 'tool' }, t('setup.reg.again'));
    const out = h('p', { role: 'status', class: 'hint-line' });
    const sync = (r) => {
      lines.replaceChildren(...r.hosts.map((x) => h('li', { class: `reg-${x.state}` },
        h('span', { class: 'glyph', 'aria-hidden': 'true' }, REG_GLYPH[x.state] || '?'), ' ', registrationText(t, x))));
      again.disabled = r.state === 'running';
      again.setAttribute('aria-busy', String(r.state === 'running'));
    };
    again.addEventListener('click', async () => {
      if (!currentHandle()) { out.textContent = t('send.locked'); return; }
      out.textContent = '';
      const r = await registerNow().catch(() => null);
      if (r) out.textContent = t(r.state === 'ok' ? 'setup.reg.allOk' : 'setup.reg.notAll');
    });
    sync(registration());
    const stop = onRegistration(sync);
    ctx.signal.addEventListener('abort', stop, { once: true });
    return block('reg-title', t('setup.reg.title'), h('p', { class: 'muted' }, t('setup.reg.body')), lines,
      h('div', { class: 'row' }, again), out);
  }

  function replaceBlock() {
    const open = h('button', { type: 'button', class: 'tool tool-danger' }, t('keyscreen.replace'));
    open.addEventListener('click', () => {
      const keep = h('button', { type: 'button', class: 'button', autofocus: true }, t('keyscreen.keep'));
      const go = h('button', { type: 'button', class: 'tool tool-danger' }, t('keyscreen.replaceIt'));
      const dialog = h('dialog', { class: 'dlg', 'aria-labelledby': 'replace-title', closedby: 'any' },
        h('h2', { id: 'replace-title' }, t('keyscreen.replaceTitle')),
        h('ul', { class: 'cost' },
          h('li', {}, t('keyscreen.cost1')),
          h('li', {}, t('keyscreen.cost2')),
          h('li', {}, t('keyscreen.cost3'))),
        h('div', { class: 'row-end' }, go, keep));
      keep.addEventListener('click', () => dialog.close(''));
      go.addEventListener('click', () => dialog.close('replace'));
      dialog.addEventListener('close', () => {
        const yes = dialog.returnValue === 'replace';
        dialog.returnValue = '';
        dialog.remove();
        if (yes) ctx.navigate('#/unlock/replace');
      }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
    });
    return block('replace-block-title', t('keyscreen.replaceBlock'), h('p', {}, t('keyscreen.replaceBody')), h('div', { class: 'row' }, open));
  }

  draw(keyStatus());
  const stop = onKeyStatus((s) => {
    if (s.locked) seed.hide();
    // Redraw on a lock or a change, but never under the person's typing.
    if (body.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) {
      const lockSection = body.querySelector('[aria-labelledby="lock-title"]');
      if (lockSection && !lockSection.contains(document.activeElement)) lockSection.replaceWith(lockBlock(s));
      return;
    }
    draw(s);
  });
  // A tab sent to the background hides it too: it is not left on screen behind another window.
  document.addEventListener('visibilitychange', () => { if (document.hidden) seed.hide(); }, { signal: ctx.signal });
  ctx.signal.addEventListener('abort', () => { stop(); seed.hide(); }, { once: true });
  return section;
}
