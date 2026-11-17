// Setup (W-20d, proposal §2.5): one modal with tabs in the order an owner meets them. Interim:
// each tab shows today's screen as it is; the Setup ticket replaces this file. "#setup" opens the
// first tab, "#setup/<tab>/<args>" a tab (old "#/groups/<name>" lands on "#setup/groups/<name>").
import { h } from '../dom.js';
import * as key from '../screens/key.js';
import * as setupScreen from '../screens/setup.js';
import * as settings from '../screens/settings.js';
import * as groups from '../screens/groups.js';
import * as sets from '../screens/sets.js';
import { areaPicker } from '../area.js';

const displayTab = {
  route: 'display',
  render: (ctx) => h('section', { class: 'scr', 'aria-labelledby': 'display-title' },
    h('h2', { id: 'display-title' }, ctx.t('display.title')), ctx.displaySettings()),
};

// Area and brokers (proposal §2.5, tab 3): the area picker (ui/area.js, W-20b).
const areaTab = {
  route: 'area',
  render: (ctx) => h('section', { class: 'scr', 'aria-labelledby': 'area-title' },
    h('h2', { id: 'area-title' }, ctx.t('area.label')), areaPicker(ctx, { id: 'area-choice' })),
};

// tab -> [label key, screen]
export const TABS = Object.freeze({
  key: ['nav.key', key],
  node: ['nav.setup', setupScreen],
  area: ['area.label', areaTab],
  settings: ['nav.settings', settings],
  groups: ['nav.groups', groups],
  sets: ['sets.title', sets],
  display: ['settings.display', displayTab],
});

export const setupModal = {
  name: 'setup',
  title: 'setup.modalTitle',
  render(ctx) {
    const tab = TABS[ctx.args[0]] ? ctx.args[0] : 'key';
    const [, screen] = TABS[tab];
    const nav = h('nav', { class: 'tabs', 'aria-label': ctx.t('setup.tabs') },
      h('ul', {}, Object.entries(TABS).map(([name, [label]]) => h('li', {},
        h('a', { href: `#setup/${name}`, 'aria-current': name === tab ? 'page' : null }, ctx.t(label))))));
    const content = screen.render({ ...ctx, route: screen.route, args: ctx.args.slice(1) });
    return h('div', { class: 'setup' },
      h('h1', { id: 'setup-title', class: 'modal-title' }, ctx.t('setup.modalTitle')), nav, content);
  },
};
