// Every screen, by route. A screen is a module exporting `route` (the part after `#/`) and
// `render(ctx)` returning one element; add it here and it is reachable.
import * as home from './home.js';
import * as notfound from './notfound.js';

export const SCREENS = [home];
export const NOT_FOUND = notfound;
