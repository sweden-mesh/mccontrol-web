// Setup (W-20d, proposal §2.5): one modal with seven tabs, in the order an owner meets them. Each
// tab has its own address, "#setup/<tab>/<args>", so a link, Back and the old routes land on it
// ("#/groups/<name>" -> "#setup/groups/<name>"; "#setup" is the first tab). The tabs are links in
// one row (it scrolls sideways on a phone), the current one marked aria-current: choosing one is
// a change of address, not a panel switch inside the page.
import { h } from '../dom.js';
import * as key from '../screens/key.js';
import * as node from '../screens/setup.js';
import { renderConnections, renderWarnings } from '../screens/settings.js';
import * as groups from '../screens/groups.js';
import * as sets from '../screens/sets.js';
import { tabScreen } from '../screens/key-kit.js';

const display = (ctx) => tabScreen('display', ctx.t('setup.tab.display'),
  h('p', { class: 'muted' }, ctx.t('settings.displayBody')), ctx.displaySettings());

// tab -> { label (i18n key), route, render(ctx) }, in this order. `route` is the tab's old
// screen route: the screens build "unlock, then come back here" links from it.
export const TABS = Object.freeze({
  key: { label: 'setup.tab.key', route: 'key', render: key.render },
  node: { label: 'setup.tab.node', route: 'setup', render: node.render },
  connections: { label: 'setup.tab.connections', route: 'settings', render: renderConnections },
  groups: { label: 'setup.tab.groups', route: 'groups', render: groups.render },
  sets: { label: 'setup.tab.sets', route: 'sets', render: sets.render },
  warnings: { label: 'setup.tab.warnings', route: 'settings', render: renderWarnings },
  display: { label: 'setup.tab.display', route: 'settings', render: display },
});

// Older names of a tab: "#setup/settings" (the old settings screen) and "#setup/area" (the area
// choice, gone with IATA-2) are the connections tab.
export const ALIASES = Object.freeze({ settings: 'connections', area: 'connections', setup: 'node' });

export const tabFor = (name) => (TABS[name] ? name : ALIASES[name] || null);

export const setupModal = {
  name: 'setup',
  title: 'setup.modalTitle',
  render(ctx) {
    const tab = tabFor(ctx.args[0]) || 'key';
    const nav = h('nav', { class: 'tabs', 'aria-label': ctx.t('setup.tabs') },
      h('ul', {}, Object.entries(TABS).map(([name, { label }]) => h('li', {},
        h('a', { href: `#setup/${name}`, 'aria-current': name === tab ? 'page' : null }, ctx.t(label))))));
    const rest = tabFor(ctx.args[0]) ? ctx.args.slice(1) : [];
    const content = TABS[tab].render({ ...ctx, route: TABS[tab].route, args: rest });
    // The current tab in view when the row scrolls (a phone).
    queueMicrotask(() => nav.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', container: 'nearest' }));
    return h('div', { class: 'setup' },
      h('h1', { id: 'setup-title', class: 'modal-title' }, ctx.t('setup.modalTitle')), nav,
      h('div', { class: 'setup-tab' }, content));
  },
};
