// Key and backup (W-5): the public key, copy and QR code, lock, the copies the owner may keep
// (the backup file, or the private key shown after the passphrase) and the browser's keeping of
// it, the passphrase, fingerprint unlock, registering with a broker, and replacing the key behind
// a dialog that says what it costs. Keeping a copy is the owner's job (operator 2026-11-17).
import { h } from '../dom.js';
import { download } from './node-kit.js';
import { copyButton, errorLine, groupedHex, passField, qrSvg, useStyles } from './key-kit.js';
import { currentHandle, keyring, keyStatus, onKeyStatus, unlockHash } from './key-session.js';
import { brokerConfig, brokerTable } from './settings-store.js';
import { loadAll } from '../../lib/data/load.js';
import { register } from '../../lib/protocol/transport.js';
import { passProblem, MIN } from './unlock.js';

export const route = 'key';
export const title = 'nav.key';

// The brokers a key may register with: the shared one, then each region's own.
export function brokerChoices(brokers, regions = {}) {
  const out = [{ value: '', host: brokers.shared, regions: [] }];
  for (const [region, host] of Object.entries(regions)) {
    const found = out.find((b) => b.host === host);
    if (found) found.regions.push(region); else out.push({ value: region, host, regions: [region] });
  }
  return out;
}

// How long the private key stays on screen once shown.
export const REVEAL_MS = 60000;

// The shown private key: show(hex) holds it and hides it again after `ms`; hide() drops it and
// calls onHide once. value() is the hex while shown, else null.
export function revealer(onHide, { ms = REVEAL_MS, timers = globalThis } = {}) {
  let value = null;
  let timer = null;
  const hide = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (value === null) return;
    value = null;
    onHide();
  };
  return {
    show(hex) { hide(); value = hex; timer = timers.setTimeout(hide, ms); },
    hide,
    value: () => value,
  };
}

export const autoLockText = (t, minutes) => (minutes === null ? t('key.autolock.tab') : t(`key.autolock.${minutes}`));

const block = (id, heading, ...children) => h('section', { class: 'key-block', 'aria-labelledby': id },
  h('h2', { id }, heading), ...children);

function busy(button, on) { button.disabled = on; button.setAttribute('aria-busy', String(on)); }

export function render(ctx) {
  useStyles();
  const { t } = ctx;
  const body = h('div', {});
  const section = h('section', { 'aria-labelledby': 'key-title', class: 'scr key-screen' },
    h('h1', { id: 'key-title' }, t('nav.key')), body);
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
    body.replaceChildren(publicBlock(s), lockBlock(s), backupBlock(s), passBlock(s), fingerprintBlock(s), registerBlock(), replaceBlock(),
      h('p', {}, h('a', { href: '#/help/signing' }, t('keyscreen.helpLink'))));
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
      h('p', {}, h('a', { href: '#/setup' }, t('keyscreen.toSetup'))));
  }

  function lockBlock(s) {
    const lock = h('button', { type: 'button', class: 'button' }, t('keyscreen.lockNow'));
    lock.addEventListener('click', () => { ring.lock(); ctx.announce(t('keyscreen.lockedNow')); });
    return block('lock-title', t('keyscreen.lock'),
      h('p', {}, t(s.locked ? 'keyscreen.isLocked' : 'keyscreen.isUnlocked')),
      h('p', { class: 'muted' }, t('keyscreen.autoLock', { when: autoLockText(t, s.autoLockMinutes) }), ' ',
        h('a', { href: '#/settings' }, t('keyscreen.changeInSettings'))),
      s.locked ? h('p', {}, h('a', { class: 'button', href: unlockHash('key') }, t('unlock.unlock'))) : h('div', { class: 'row' }, lock));
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
          h('div', { class: 'row wrap' }, copyButton(t, () => seed.value() ?? '', t('keyscreen.seedCopy')), hide),
          h('p', { class: 'hint-line' }, t('keyscreen.seedWhen')));
        hide.focus();
      } catch { err.textContent = t('unlock.wrong'); } finally { busy(go, false); }
    });
    return h('details', { class: 'block' }, h('summary', {}, t('keyscreen.seed')), form, slot);
  }

  function passBlock() {
    const old = passField(t, { label: t('keyscreen.oldPass'), autocomplete: 'current-password', name: 'passphrase' });
    const first = passField(t, { label: t('keyscreen.newPass'), autocomplete: 'new-password', name: 'new-passphrase', hint: t('unlock.passHint', { min: MIN }) });
    const second = passField(t, { label: t('unlock.passAgain'), autocomplete: 'new-password', name: 'new-passphrase-again' });
    const err = errorLine();
    const go = h('button', { type: 'submit', class: 'button' }, t('keyscreen.changePass'));
    const form = h('form', { class: 'stack', novalidate: true }, old.el, first.el, second.el,
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

  function registerBlock() {
    const slot = h('div', {}, h('p', { class: 'muted' }, t('node.loading')));
    loadAll().then(({ brokers }) => {
      const choices = brokerChoices(brokers, brokerTable(brokers).regions);
      const select = h('select', { id: 'register-broker' }, choices.map((c) => h('option', { value: c.value },
        c.regions.length ? `${c.host} (${c.regions.join(', ')})` : t('keyscreen.sharedBroker', { host: c.host }))));
      const go = h('button', { type: 'button', class: 'button' }, t('keyscreen.register'));
      const out = h('p', { role: 'status' });
      go.addEventListener('click', async () => {
        const handle = currentHandle();
        if (!handle) { out.replaceChildren(t('send.locked'), ' ', h('a', { href: unlockHash('key') }, t('send.unlockLink'))); return; }
        busy(go, true);
        out.textContent = t('keyscreen.registering');
        try {
          const res = await register({ config: brokerConfig(brokers, select.value), handle, signal: ctx.signal });
          out.textContent = res.ok ? t('keyscreen.registered') : t('keyscreen.registerNot', { detail: res.detail });
        } catch (ex) {
          out.textContent = t('keyscreen.registerFailed', { reason: ex.message });
        } finally { busy(go, false); }
      });
      slot.replaceChildren(h('div', { class: 'field' }, h('label', { for: 'register-broker' }, t('keyscreen.broker')), select),
        h('div', { class: 'row' }, go), out);
    }).catch((ex) => slot.replaceChildren(h('p', { class: 'err' }, ex.message)));
    return block('reg-title', t('keyscreen.registerTitle'), h('p', {}, t('keyscreen.registerBody')), slot);
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
      body.querySelectorAll('.key-block')[1]?.replaceWith(lockBlock(s));
      return;
    }
    draw(s);
  });
  ctx.signal.addEventListener('abort', () => { stop(); seed.hide(); }, { once: true });
  return section;
}
