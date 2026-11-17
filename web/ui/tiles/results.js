// RESULTS (W-20c): every answer, refusal and silence, newest first, kept until seen.
// Placeholder until its ticket lands: today's history is the "history" modal.
import { h } from '../dom.js';

export const id = 'results';
export const title = 'tile.results';

export function render(ctx) {
  return h('p', { class: 'row' }, h('a', { href: '#history' }, ctx.t('tile.openHistory')));
}
