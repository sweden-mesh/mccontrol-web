// Start and unlock (W-5). One screen for every way in:
//   #/unlock                 no key: make one or import one; a locked key: unlock it
//   #/unlock/replace         make or import another key in place of this one (the key screen's
//                            dialog has said what that costs)
//   #/unlock/to/<route>/...  unlock, then go back to that screen
// A new or imported key goes straight to the key screen: keeping a copy of it is the owner's
// job (operator 2026-11-17), said once on the make form.
import { h } from '../dom.js';
import { errorLine, passField, showPassphrases, useStyles } from './key-kit.js';
import { keyring, keyStatus } from './key-session.js';

export const route = 'unlock';
export const title = 'nav.unlock';

export const MIN = 8;

// What the address asks for: { replace, next } where next is the hash to go to afterwards.
export function unlockTarget(args = []) {
  if (args[0] === 'replace') return { replace: true, next: '#/key' };
  if (args[0] === 'to' && args.length > 1) {
    const path = args.slice(1).filter((a) => a !== 'unlock').map(encodeURIComponent).join('/');
    return { replace: false, next: `#/${path}` };
  }
  return { replace: false, next: null };
}

// Which step a status calls for. `replace` starts over whatever is stored.
export function stepFor(status, { replace = false } = {}) {
  if (replace || !status.exists) return 'start';
  if (status.locked) return 'unlock';
  return 'done';
}

// Why a new passphrase cannot be used yet, or null: 'short' | 'mismatch'.
export function passProblem(first, second) {
  if ([...String(first || '')].length < MIN) return 'short';
  if (second !== undefined && first !== second) return 'mismatch';
  return null;
}

// What pasted or loaded text holds: 'backup' (the encrypted file), 'seed' (64 hex) or null.
export function importKind(text) {
  const body = String(text || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(body)) return 'seed';
  if (!body.startsWith('{')) return null;
  try {
    return JSON.parse(body)?.format === 'mccontrol-key-backup' ? 'backup' : null;
  } catch {
    return null;
  }
}

function busy(button, on) {
  button.disabled = on;
  button.setAttribute('aria-busy', on ? 'true' : 'false');
}

export function render(ctx) {
  useStyles();
  const { t } = ctx;
  const target = unlockTarget(ctx.args);
  const heading = h('h1', { id: 'unlock-title' });
  const body = h('div', { class: 'key-flow' });
  const section = h('section', { 'aria-labelledby': 'unlock-title', class: 'scr key-screen' }, heading, body);

  const ring = keyring();
  if (!ring) {
    heading.textContent = t('nav.unlock');
    body.append(h('p', {}, t('unlock.unavailable')));
    return section;
  }

  const finish = () => ctx.navigate(target.next || '#/key');

  // Show a step: its heading, its body, focus on the heading when it replaces another.
  const go = (step, { focus = true } = {}) => {
    const fill = { start: startStep, unlock: unlockStep, done: doneStep }[step];
    heading.textContent = t(`unlock.h.${step === 'start' && target.replace ? 'replace' : step}`);
    body.replaceChildren(...fill());
    if (focus) { heading.tabIndex = -1; heading.focus(); }
    if (!ctx.signal.aborted) document.title = `${heading.textContent} · mccontrol`;
  };
  function startStep() {
    const forms = h('div', {});
    const makeBtn = h('button', { type: 'button', class: 'tool choice-button', 'aria-pressed': 'false', 'aria-controls': 'unlock-form' }, t('unlock.make'));
    const importBtn = h('button', { type: 'button', class: 'tool choice-button', 'aria-pressed': 'false', 'aria-controls': 'unlock-form' }, t('unlock.import'));
    forms.id = 'unlock-form';
    const pick = (which) => {
      makeBtn.setAttribute('aria-pressed', String(which === 'make'));
      importBtn.setAttribute('aria-pressed', String(which === 'import'));
      forms.replaceChildren(which === 'make' ? makeForm() : importForm());
      forms.querySelector('input, textarea')?.focus();
    };
    makeBtn.addEventListener('click', () => pick('make'));
    importBtn.addEventListener('click', () => pick('import'));
    return [
      target.replace ? h('p', { class: 'warn-text' }, t('unlock.replaceWarn')) : null,
      h('p', {}, t('unlock.intro')),
      h('div', { class: 'choice-row' }, makeBtn, importBtn),
      forms,
    ].filter(Boolean);
  }

  function makeForm() {
    const first = passField(t, { label: t('unlock.pass'), autocomplete: 'new-password', name: 'new-passphrase', hint: t('unlock.passHint', { min: MIN }), toggle: false });
    const second = passField(t, { label: t('unlock.passAgain'), autocomplete: 'new-password', name: 'new-passphrase-again', toggle: false });
    const err = errorLine();
    const submit = h('button', { type: 'submit', class: 'button' }, t('unlock.makeSubmit'));
    const form = h('form', { class: 'stack', 'aria-labelledby': 'make-title', novalidate: true },
      h('h2', { id: 'make-title' }, t('unlock.make')),
      h('p', {}, t('unlock.makeBody')),
      first.el, second.el, showPassphrases(t, [first, second]),
      h('p', { class: 'muted' }, t('unlock.noRecovery')),
      h('p', { class: 'muted' }, t('unlock.ownCopy')),
      h('div', { class: 'row' }, submit), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = passProblem(first.input.value, second.input.value);
      first.input.setAttribute('aria-invalid', String(problem === 'short'));
      second.input.setAttribute('aria-invalid', String(problem === 'mismatch'));
      if (problem) {
        err.textContent = t(`unlock.problem.${problem}`, { min: MIN });
        (problem === 'short' ? first : second).input.focus();
        return;
      }
      busy(submit, true);
      err.textContent = '';
      try {
        await ring.create(first.input.value, { replace: target.replace });
        finish();
      } catch (ex) {
        err.textContent = ex.message;
      } finally { busy(submit, false); }
    });
    return form;
  }

  function importForm() {
    const fileId = 'import-file';
    const file = h('input', { type: 'file', id: fileId, accept: '.json,.seed,.txt,application/json,text/plain' });
    const paste = h('textarea', { id: 'import-paste', rows: '3', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', class: 'mono', 'aria-describedby': 'import-paste-hint' });
    const kindLine = h('p', { class: 'hint-line', role: 'status' });
    const backupPass = passField(t, { label: t('unlock.backupPass'), autocomplete: 'current-password', name: 'passphrase', hint: t('unlock.backupPassHint'), toggle: false });
    const first = passField(t, { label: t('unlock.pass'), autocomplete: 'new-password', name: 'new-passphrase', hint: t('unlock.passHint', { min: MIN }), toggle: false });
    const second = passField(t, { label: t('unlock.passAgain'), autocomplete: 'new-password', name: 'new-passphrase-again', toggle: false });
    const seedFields = h('div', { class: 'stack' }, first.el, second.el);
    const showAll = showPassphrases(t, [backupPass, first, second]);
    const err = errorLine();
    const submit = h('button', { type: 'submit', class: 'button' }, t('unlock.importSubmit'));
    let text = '';
    const sync = () => {
      const kind = importKind(text);
      backupPass.el.hidden = kind !== 'backup';
      seedFields.hidden = kind !== 'seed';
      showAll.hidden = kind !== 'backup' && kind !== 'seed';
      kindLine.textContent = text ? t(`unlock.kind.${kind || 'unknown'}`) : '';
    };
    file.addEventListener('change', async () => {
      text = file.files[0] ? await file.files[0].text() : paste.value;
      sync();
    });
    paste.addEventListener('input', () => { text = paste.value; sync(); });
    const form = h('form', { class: 'stack', 'aria-labelledby': 'import-title', novalidate: true },
      h('h2', { id: 'import-title' }, t('unlock.import')),
      h('p', {}, t('unlock.importBody')),
      h('div', { class: 'field' }, h('label', { for: fileId }, t('unlock.file')), file),
      h('div', { class: 'field' }, h('label', { for: 'import-paste' }, t('unlock.paste')), paste,
        h('p', { class: 'hint-line', id: 'import-paste-hint' }, t('unlock.pasteHint'))),
      kindLine, backupPass.el, seedFields, showAll,
      h('div', { class: 'row' }, submit), err);
    sync();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = importKind(text);
      err.textContent = '';
      if (!kind) { err.textContent = t('unlock.kind.unknown'); paste.focus(); return; }
      let pass;
      if (kind === 'seed') {
        const problem = passProblem(first.input.value, second.input.value);
        if (problem) { err.textContent = t(`unlock.problem.${problem}`, { min: MIN }); (problem === 'short' ? first : second).input.focus(); return; }
        pass = first.input.value;
      } else {
        pass = backupPass.input.value;
        if (!pass) { err.textContent = t('unlock.problem.empty'); backupPass.input.focus(); return; }
      }
      busy(submit, true);
      try {
        await ring.importKey(text, pass, { replace: target.replace });
        text = '';
        paste.value = '';
        finish();
      } catch (ex) {
        err.textContent = /passphrase is wrong/.test(ex.message) ? t('unlock.wrong') : ex.message;
      } finally { busy(submit, false); }
    });
    return form;
  }

  function unlockStep() {
    const status = keyStatus();
    const pass = passField(t, { label: t('unlock.pass'), autocomplete: 'current-password', name: 'passphrase' });
    const err = errorLine();
    const submit = h('button', { type: 'submit', class: 'button' }, t('unlock.unlock'));
    const form = h('form', { class: 'stack', 'aria-label': t('unlock.unlock'), novalidate: true },
      h('p', {}, t('unlock.locked')),
      pass.el, h('div', { class: 'row wrap' }, submit), err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pass.input.value) { err.textContent = t('unlock.problem.empty'); pass.input.focus(); return; }
      busy(submit, true);
      err.textContent = '';
      try {
        await ring.unlock(pass.input.value);
        finish();
      } catch {
        err.textContent = t('unlock.wrong');
        pass.input.select();
        pass.input.focus();
      } finally { busy(submit, false); }
    });
    const out = [form];
    if (status.fingerprint) {
      const fp = h('button', { type: 'button', class: 'tool' }, t('unlock.fingerprint'));
      fp.addEventListener('click', async () => {
        busy(fp, true);
        err.textContent = '';
        try {
          await ring.unlockWithFingerprint();
          finish();
        } catch {
          err.textContent = t('unlock.fingerprintFailed');
        } finally { busy(fp, false); }
      });
      form.querySelector('.row').append(fp);
    }
    out.push(h('details', { class: 'block' },
      h('summary', {}, t('unlock.forgot')),
      h('p', {}, t('unlock.forgotBody')),
      h('p', {}, h('a', { href: '#/unlock/replace' }, t('unlock.forgotReplace')))));
    return out;
  }

  function doneStep() {
    if (target.next) queueMicrotask(() => { if (!ctx.signal.aborted) ctx.navigate(target.next); });
    return [h('p', {}, t('unlock.already')), h('p', {}, h('a', { href: '#/key' }, t('nav.key')))];
  }

  // The first draw is from the status the session holds; focus is the shell's.
  const first = stepFor(keyStatus(), { replace: target.replace });
  go(first, { focus: false });
  if (target.replace && !keyStatus().exists) heading.textContent = t('unlock.h.start');
  return section;
}
