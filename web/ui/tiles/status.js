// STATUS (W-20c, W-20e): broker, key, registration, companion, the refresh and discovery clocks,
// each line a button where it can act. Placeholder until its ticket lands: the key line, and
// today's overview as a modal.
import { h } from '../dom.js';

export const id = 'status';
export const title = 'tile.status';

export function render(ctx) {
  const key = h('li', { class: 'row' });
  const draw = () => {
    const { status } = ctx.key.state();
    const href = status === 'unlocked' ? '#setup/key' : '#unlock';
    key.replaceChildren(h('span', { class: 'row-name' }, ctx.t('status.key')), ' ',
      h('a', { href }, ctx.t(`key.${status}`)));
  };
  ctx.signal.addEventListener('abort', ctx.key.on(draw), { once: true });
  draw();
  return h('ul', { class: 'rows' }, key,
    h('li', { class: 'row' }, h('a', { href: '#overview' }, ctx.t('tile.openOverview'))));
}
