import { h } from '../dom.js';

export const route = null;

export function render({ t }) {
  return h('section', { 'aria-labelledby': 'nf-title' },
    h('h2', { id: 'nf-title' }, t('notfound.title')),
    h('p', {}, h('a', { href: '#/' }, t('notfound.body'))));
}
