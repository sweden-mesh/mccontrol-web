// NODE (W-20c, W-20j): the selected node, named on the tile's border ("GISEBO 4AC61A7F"), with
// its facts, sparklines, log and the command line at the bottom (node-view.js). Not on the board
// on a phone: there selecting a node opens the "node" modal (nodeModal below), the same view full
// screen with the command line pinned to the bottom.
import { h } from '../dom.js';
import { nameOf } from '../screens/node-kit.js';
import { forKey } from './kit.js';
import { nodeView } from './node-view.js';

export const id = 'node';
export const title = 'tile.node';

export function render(ctx) {
  const body = h('div', { class: 'tile-fill node-tile' });
  forKey(ctx, body, (svc) => {
    let shown = null;
    let leave = null;
    const draw = () => {
      const sel = ctx.board.selected();
      if (sel === shown) return;
      shown = sel;
      leave?.abort();
      if (!sel) {
        ctx.tile.setTitle('');
        body.replaceChildren(h('p', { class: 'row muted' }, ctx.t('tile.noSelection')));
        return;
      }
      leave = new AbortController();
      ctx.signal.addEventListener('abort', () => leave.abort(), { once: true });
      const sub = Object.freeze({ ...ctx, signal: leave.signal });
      ctx.tile.setTitle(sel);
      body.replaceChildren(nodeView(sub, svc, sel, {
        heading: (d) => ctx.tile.setTitle(d ? `${nameOf(d)}  ${d.node}` : sel),
      }));
    };
    ctx.board.on(draw);
    draw();
  });
  return body;
}

// The "node" modal (#node/<id>): the phone's full-screen node, and where old links land.
export const nodeModal = Object.freeze({
  name: 'node',
  title: 'tile.node',
  render(ctx) {
    const nodeId = String(ctx.args[0] || '').toUpperCase();
    const heading = h('h1', { class: 'node-modal-title' }, nodeId);
    const body = h('div', { class: 'node-modal-body' });
    forKey(ctx, body, (svc) => {
      body.replaceChildren(nodeView(ctx, svc, nodeId, {
        heading: (d) => {
          heading.textContent = d ? nameOf(d) : ctx.t('node.missing');
          if (d) document.title = `${nameOf(d)} · mccontrol`;
        },
      }));
    });
    return h('section', { class: 'node-modal', 'aria-labelledby': 'node-modal-title' },
      Object.assign(heading, { id: 'node-modal-title' }), body);
  },
});
