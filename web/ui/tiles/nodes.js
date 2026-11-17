// NODES (W-20c): one row per node, what needs attention first, tags, search on '/'.
// Placeholder until its ticket lands: today's node list is the "nodes" modal.
import { h } from '../dom.js';

export const id = 'nodes';
export const title = 'tile.nodes';

export function render(ctx) {
  return h('ul', { class: 'rows' },
    h('li', { class: 'row' }, h('a', { href: '#nodes' }, ctx.t('tile.openNodes'))),
    h('li', { class: 'row' }, h('a', { href: '#send' }, ctx.t('tile.openSend'))));
}
