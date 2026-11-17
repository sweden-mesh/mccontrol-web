// NODE (W-20c, W-20j): the selected node's facts with their ages, its log, and the command line
// at the bottom. Not on the board on a phone: there the node opens full screen ("node" modal).
// Placeholder until its ticket lands: it follows the selection and links to today's node screen.
import { h } from '../dom.js';

export const id = 'node';
export const title = 'tile.node';

export function render(ctx) {
  const body = h('div', { class: 'rows' });
  const draw = () => {
    const id = ctx.board.selected();
    ctx.tile.setTitle(id || '');
    body.replaceChildren(id
      ? h('p', { class: 'row' }, h('a', { href: `#node/${id}` }, ctx.t('tile.openNode', { id })))
      : h('p', { class: 'row muted' }, ctx.t('tile.noSelection')));
  };
  ctx.board.on(draw);
  draw();
  return body;
}
