// The board's tiles. Each module exports `id` (one of board.js's TILES), `title` (an i18n key)
// and `render(ctx)`; see README "The board's tiles". One file per tile, so each tile's owner
// works in its own file.
import { registerTile } from '../board.js';
import * as nodes from './nodes.js';
import * as node from './node.js';
import * as status from './status.js';
import * as map from './map.js';
import * as results from './results.js';

for (const tile of [nodes, node, status, map, results]) registerTile(tile);
