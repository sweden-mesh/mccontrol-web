// Every screen, by route. A screen is a module (or frozen object) with `route` (the part after
// `#/`), `title` (an i18n key, used for the menu and the window title) and `render(ctx)` returning
// one element whose first heading is an <h1>. Add it here and it is reachable; list its route in
// NAV to put it in the menu. The placeholders are replaced by the screens streams (plan §7).
import * as home from './home.js';
import * as notfound from './notfound.js';
import { placeholder } from './placeholder.js';

export const SCREENS = [
  home,                                           // the overview dashboard (W-18)
  placeholder('nodes', 'nav.nodes'),              // my nodes (W-7)
  placeholder('node', 'nav.node'),                // one node: #/node/<public key> (W-7, W-8)
  placeholder('groups', 'nav.groups'),            // groups (W-9)
  placeholder('history', 'nav.history'),          // history (W-9)
  placeholder('setup', 'nav.setup'),              // set up a node (W-13)
  placeholder('key', 'nav.key'),                  // key and backup (W-5)
  placeholder('unlock', 'nav.unlock'),            // start / unlock (W-5)
  placeholder('settings', 'nav.settings'),        // settings; the display settings are the shell's
  placeholder('help', 'nav.help'),                // help (W-8)
];

// The menu, in this order. `node` and `unlock` are reached from other screens and the header.
export const NAV = ['', 'nodes', 'groups', 'history', 'setup', 'key', 'settings', 'help'];

export const NOT_FOUND = notfound;
