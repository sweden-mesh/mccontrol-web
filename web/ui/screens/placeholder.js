// A screen that is not built yet: its title and one line saying so. The screens streams replace
// each one in index.js with their own module.
import { h } from '../dom.js';

export function placeholder(route, title) {
  return Object.freeze({
    route,
    title,
    render({ t }) {
      return h('section', { 'aria-labelledby': `${route}-title` },
        h('h1', { id: `${route}-title` }, t(title)),
        h('p', { class: 'muted' }, t('app.notBuilt')));
    },
  });
}
