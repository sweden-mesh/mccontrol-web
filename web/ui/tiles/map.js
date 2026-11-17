// MAP (W-20c): the owner's nodes as dots on a plain outline of the area, drawn here, no map
// tiles and no new origin (operator decision 4). Placeholder until its ticket lands.
import { h } from '../dom.js';

export const id = 'map';
export const title = 'tile.map';

export function render(ctx) {
  return h('p', { class: 'row muted' }, ctx.t('app.notBuilt'));
}
