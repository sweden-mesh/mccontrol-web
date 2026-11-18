// Setup's "Connections" and "Warnings" tabs (proposal §2.5): the command server and the companion
// radio for the mesh road (W-16); when the board warns (low battery, not heard) and
// when the auto road takes the mesh. All on this device only (settings-store.js). Every change
// applies at once and says so in a status line. Auto-lock is the Key tab's, display the Display tab's.
import { h } from '../dom.js';
import { useStyles } from './key-kit.js';
import {
  DEFAULTS, LIMITS, lowBatteryVolts, meshAfterMins, notHeardHours, regionBrokers, removeRegionBroker, setLowBatteryVolts,
  setMeshAfterMins, setNotHeardHours,
} from './settings-store.js';
import { companionControl } from './road-kit.js';
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

// The command server: the shared one, wherever a node is (IATA-2: no region, no area). Own command
// servers set up per IATA code before lou-20 are still used for lou-19-and-older nodes and listed
// here to be removed; new ones are not added (they end with the old scheme, lou-21).
function brokersBlock(ctx) {
  const { t } = ctx;
  const list = h('div', {});
  const status = h('p', { role: 'status' });
  let shared = 'mqtt-meshcore.louie.se';
  const draw = () => {
    const rows = Object.entries(regionBrokers()).sort();
    list.replaceChildren(h('dl', { class: 'facts brokers' },
      h('dt', {}, t('settings.everyRegion')), h('dd', {}, h('code', {}, `wss://${shared}`)),
      rows.flatMap(([region, host]) => {
        const remove = h('button', { type: 'button', class: 'link-button', 'aria-label': t('settings.removeLabel', { region }) }, t('settings.remove'));
        remove.addEventListener('click', () => {
          removeRegionBroker(region);
          status.textContent = t('settings.removed', { region, host: shared });
          draw();
        });
        return [h('dt', {}, t('settings.legacyBroker')), h('dd', {}, h('code', {}, `wss://${host}`), ' ', remove)];
      })));
  };
  loadAll().then(({ brokers }) => { shared = brokers.shared; draw(); }).catch(() => draw());
  draw();
  return block('brokers-title', t('settings.brokers'), h('p', {}, t('settings.brokersBody')), list, status,
    h('p', {}, h('a', { href: '#help/ownregion' }, t('settings.brokersHelp'))));
}

const tabSection = (id, title, ...children) => h('section', { 'aria-labelledby': id, class: 'scr key-screen' },
  h('h2', { id }, title), ...children);

// Setup's "Connections" tab: where commands go (the command server) and the companion radio the
// mesh road uses. No area: the owner's nodes are found wherever they are (IATA-2).
export function renderConnections(ctx) {
  useStyles();
  const { t } = ctx;
  return tabSection('connections-title', t('setup.tab.connections'),
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

// The old settings screen (#/settings) is Setup's connections tab now; kept for the screen list.
export const render = renderConnections;
