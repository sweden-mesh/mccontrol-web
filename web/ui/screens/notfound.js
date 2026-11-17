import { h } from '../dom.js';

export const route = null;
export const title = 'notfound.title';

export function render({ t }) {
  return h('section', { 'aria-labelledby': 'nf-title' },
    h('h1', { id: 'nf-title' }, t('notfound.title')),
    h('p', {}, h('a', { href: '#/' }, t('notfound.body'))));
}
