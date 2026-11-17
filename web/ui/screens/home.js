// The placeholder start screen. W-18 replaces it with the overview dashboard.
import { h } from '../dom.js';

export const route = '';
export const title = 'nav.home';

export function render({ t }) {
  return h('section', { 'aria-labelledby': 'home-title' },
    h('h1', { id: 'home-title' }, t('nav.home')),
    h('p', {}, t('home.body')));
}
