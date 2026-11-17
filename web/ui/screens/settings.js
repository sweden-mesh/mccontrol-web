// Settings: the display (the shell's form), auto-lock (kept with the key), when the overview warns
// (low battery, not heard) and a broker per region, the last three on this device only
// (settings-store.js). Every change applies at once and says so in a status line.
import { h } from '../dom.js';
import { useStyles } from './key-kit.js';
import { keyring, keyStatus, onKeyStatus } from './key-session.js';
import { AUTO_LOCK_CHOICES } from '../../lib/key/keyring.js';
import { autoLockText } from './key.js';
import {
  DEFAULTS, LIMITS, lowBatteryVolts, notHeardHours, regionBrokers, removeRegionBroker, setLowBatteryVolts,
  setNotHeardHours, setRegionBroker, validHost, validRegion,
} from './settings-store.js';
import { loadAll } from '../../lib/data/load.js';

export const route = 'settings';
export const title = 'nav.settings';

const block = (id, heading, ...children) => h('section', { class: 'key-block', 'aria-labelledby': id },
  h('h2', { id }, heading), ...children);

function autoLockBlock(ctx) {
  const { t } = ctx;
  const slot = h('div', {});
  const draw = (s) => {
    if (!s.exists) { slot.replaceChildren(h('p', { class: 'muted' }, t('settings.autoLockNoKey'))); return; }
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
    slot.replaceChildren(fieldset, h('p', { class: 'hint' }, t('settings.autoLockHint')), saved);
  };
  draw(keyStatus());
  const stop = onKeyStatus((s) => { if (!slot.contains(document.activeElement)) draw(s); });
  ctx.signal.addEventListener('abort', stop, { once: true });
  return block('autolock-title', t('settings.autoLock'), slot);
}

// A number field that saves on change: label, input with its unit, hint, status.
function numberField(ctx, { id, label, unit, hint, value, step, limits, save }) {
  const { t } = ctx;
  const input = h('input', { type: 'number', id, inputmode: 'decimal', step: String(step), min: String(limits[0]), max: String(limits[1]),
    value: String(value), class: 'short', 'aria-describedby': `${id}-hint ${id}-status` });
  const status = h('p', { class: 'hint-line', id: `${id}-status`, role: 'status' });
  input.addEventListener('change', () => {
    try {
      const n = save(input.value);
      input.value = String(n);
      input.removeAttribute('aria-invalid');
      status.textContent = t('settings.saved');
    } catch {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = t('settings.outOfRange', { min: limits[0], max: limits[1] });
    }
  });
  return h('div', { class: 'field' }, h('label', { for: id }, label),
    h('div', { class: 'with-unit' }, input, h('span', { 'aria-hidden': 'true' }, unit)),
    h('p', { class: 'hint-line', id: `${id}-hint` }, hint), status);
}

function brokersBlock(ctx) {
  const { t } = ctx;
  const list = h('div', {});
  const status = h('p', { role: 'status' });
  let shared = 'mqtt-meshcore.louie.se';
  const draw = () => {
    const rows = Object.entries(regionBrokers()).sort();
    list.replaceChildren(h('dl', { class: 'facts brokers' },
      h('dt', {}, t('settings.everyRegion')), h('dd', {}, h('code', {}, `wss://${shared}`), ' ', h('span', { class: 'muted' }, t('settings.default'))),
      rows.flatMap(([region, host]) => {
        const remove = h('button', { type: 'button', class: 'link-button', 'aria-label': t('settings.removeLabel', { region }) }, t('settings.remove'));
        remove.addEventListener('click', () => {
          removeRegionBroker(region);
          status.textContent = t('settings.removed', { region, host: shared });
          draw();
        });
        return [h('dt', {}, region), h('dd', {}, h('code', {}, `wss://${host}`), ' ', remove)];
      })));
  };
  loadAll().then(({ brokers }) => { shared = brokers.shared; draw(); }).catch(() => draw());
  draw();
  const region = h('input', { type: 'text', id: 'broker-region', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters',
    maxlength: '8', class: 'short', 'aria-describedby': 'broker-region-hint' });
  const host = h('input', { type: 'text', id: 'broker-host', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
    inputmode: 'url', 'aria-describedby': 'broker-host-hint' });
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'broker-region' }, t('settings.region')), region,
      h('p', { class: 'hint-line', id: 'broker-region-hint' }, t('settings.regionHint'))),
    h('div', { class: 'field' }, h('label', { for: 'broker-host' }, t('settings.host')), host,
      h('p', { class: 'hint-line', id: 'broker-host-hint' }, t('settings.hostHint'))),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'button' }, t('settings.addBroker'))), err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.textContent = '';
    region.removeAttribute('aria-invalid');
    host.removeAttribute('aria-invalid');
    if (!validRegion(region.value)) { region.setAttribute('aria-invalid', 'true'); err.textContent = t('settings.badRegion'); region.focus(); return; }
    if (!validHost(host.value)) { host.setAttribute('aria-invalid', 'true'); err.textContent = t('settings.badHost'); host.focus(); return; }
    const [r, hst] = setRegionBroker(region.value, host.value);
    region.value = ''; host.value = '';
    status.textContent = t('settings.added', { region: r, host: hst });
    draw();
  });
  return block('brokers-title', t('settings.brokers'), h('p', {}, t('settings.brokersBody')), list, form, status,
    h('p', {}, h('a', { href: '#/help/ownregion' }, t('settings.brokersHelp'))));
}

export function render(ctx) {
  useStyles();
  const { t } = ctx;
  return h('section', { 'aria-labelledby': 'settings-title', class: 'scr key-screen' },
    h('h1', { id: 'settings-title' }, t('nav.settings')),
    block('display-title', t('settings.display'), h('p', { class: 'muted' }, t('settings.displayBody')), ctx.displaySettings()),
    autoLockBlock(ctx),
    block('warn-title', t('settings.warnings'), h('p', { class: 'muted' }, t('settings.warningsBody')),
      numberField(ctx, { id: 'low-battery', label: t('settings.lowBattery'), unit: 'V', step: 0.05, limits: LIMITS.lowBatteryVolts,
        value: lowBatteryVolts(), hint: t('settings.lowBatteryHint', { v: DEFAULTS.lowBatteryVolts }), save: setLowBatteryVolts }),
      numberField(ctx, { id: 'not-heard', label: t('settings.notHeard'), unit: t('settings.hoursUnit'), step: 1, limits: LIMITS.notHeardHours,
        value: notHeardHours(), hint: t('settings.notHeardHint', { h: DEFAULTS.notHeardHours }), save: setNotHeardHours })),
    brokersBlock(ctx));
}
