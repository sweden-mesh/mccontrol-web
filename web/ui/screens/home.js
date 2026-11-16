// The placeholder start screen. W-18 replaces it with the overview dashboard.
import { h } from '../dom.js';

export const route = '';

export function render({ t }) {
  return h('section', { 'aria-labelledby': 'home-title' },
    h('h2', { id: 'home-title' }, t('home.title')),
    h('p', {}, t('home.body')));
}
