// Setup's "Area and brokers" and "Warnings" tabs (proposal §2.5): a broker per region and the
// companion radio for the mesh road (W-16); when the board warns (low battery, not heard) and
// when the auto road takes the mesh. All on this device only (settings-store.js). Every change
// applies at once and says so in a status line. Auto-lock is the Key tab's, display the Display tab's.
import { h } from '../dom.js';
import { useStyles } from './key-kit.js';
import {
  DEFAULTS, LIMITS, lowBatteryVolts, meshAfterMins, notHeardHours, regionBrokers, removeRegionBroker, setLowBatteryVolts,
  setMeshAfterMins, setNotHeardHours, setRegionBroker, validHost, validRegion,
} from './settings-store.js';
import { companionControl } from './road-kit.js';
import { areaPicker } from '../area.js';
import { meshFindBlock } from './mesh-find.js';
import { loadAll } from '../../lib/data/load.js';

export const route = 'settings';
export const title = 'nav.settings';

const block = (id, heading, ...children) => h('section', { class: 'key-block', 'aria-labelledby': id },
  h('h3', { id }, heading), ...children);

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
    h('p', {}, h('a', { href: '#help/ownregion' }, t('settings.brokersHelp'))));
}

const tabSection = (id, title, ...children) => h('section', { 'aria-labelledby': id, class: 'scr key-screen' },
  h('h2', { id }, title), ...children);

// Setup's "Area and brokers" tab: the county (ui/area.js, W-20b), where commands go (a region's
// own broker) and the companion radio the mesh road uses.
export function renderArea(ctx) {
  useStyles();
  const { t } = ctx;
  return tabSection('area-title', t('setup.tab.area'),
    block('area-label', t('area.label'), areaPicker(ctx, { id: 'area-choice' })),
    brokersBlock(ctx),
    block('companion-title', t('companion.title'), h('p', {}, t('companion.lede')),
      companionControl(ctx),
      h('p', {}, h('a', { href: '#help/mesh' }, t('road.help')))),
    block('mesh-find-title', t('mesh.find.title'), ...meshFindBlock(ctx)));
}

// Setup's "Warnings" tab: when a node is listed as needing attention, and when the auto road
// takes the mesh.
export function renderWarnings(ctx) {
  useStyles();
  const { t } = ctx;
  return tabSection('warnings-title', t('setup.tab.warnings'),
    h('p', { class: 'muted' }, t('settings.warningsBody')),
    numberField(ctx, { id: 'low-battery', label: t('settings.lowBattery'), unit: 'V', step: 0.05, limits: LIMITS.lowBatteryVolts,
      value: lowBatteryVolts(), hint: t('settings.lowBatteryHint', { v: DEFAULTS.lowBatteryVolts }), save: setLowBatteryVolts }),
    numberField(ctx, { id: 'not-heard', label: t('settings.notHeard'), unit: t('settings.hoursUnit'), step: 1, limits: LIMITS.notHeardHours,
      value: notHeardHours(), hint: t('settings.notHeardHint', { h: DEFAULTS.notHeardHours }), save: setNotHeardHours }),
    numberField(ctx, { id: 'mesh-after', label: t('settings.meshAfter'), unit: t('settings.minutesUnit'), step: 1, limits: LIMITS.meshAfterMins,
      value: meshAfterMins(), hint: t('settings.meshAfterHint', { m: DEFAULTS.meshAfterMins }), save: setMeshAfterMins }));
}

// The old settings screen (#/settings) is Setup's area tab now; kept for the screen list.
export const render = renderArea;
