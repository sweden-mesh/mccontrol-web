// Every screen, by route. A screen is a module (or frozen object) with `route` (the part after
// `#/`), `title` (an i18n key, used for the menu and the window title) and `render(ctx)` returning
// one element whose first heading is an <h1>. Add it here and it is reachable; list its route in
// NAV to put it in the menu.
import * as dashboard from './dashboard.js';
import * as nodes from './nodes.js';
import * as node from './node.js';
import * as send from './send.js';
import * as groups from './groups.js';
import * as history from './history.js';
import * as sets from './sets.js';
import * as unlock from './unlock.js';
import * as key from './key.js';
import * as setup from './setup.js';
import * as settings from './settings.js';
import * as help from './help.js';
import * as notfound from './notfound.js';
import * as stats from './stats.js';
import { provideTrafficBlock } from './dashboard.js';
import { trafficBlock } from './dashboard-traffic.js';

// The overview's 24-hour traffic block is the statistics' chart.
provideTrafficBlock(trafficBlock);

export const SCREENS = [
  dashboard,                                      // the overview dashboard (W-18)
  nodes,                                          // my nodes (W-7)
  node,                                           // one node: #/node/<id> (W-7, W-8, W-19)
  send,                                           // send to nodes, a group or a region (W-8)
  groups,                                         // groups: #/groups, #/groups/<name> (W-9)
  history,                                        // history: #/history, #/history/<id> (W-9)
  sets,                                           // command sets (W-15)
  setup,                                          // set up a node over USB (W-13)
  key,                                            // key and backup (W-5)
  unlock,                                         // start / unlock: #/unlock, #/unlock/replace, #/unlock/to/<route> (W-5)
  settings,                                       // settings; the display settings are the shell's
  help,                                           // help: #/help, #/help/<topic> (W-8)
  stats,                                          // one node's statistics: #/stats/<node id> (W-14)
];

// The menu, in this order. `node` and `unlock` are reached from other screens and the header.
export const NAV = ['', 'nodes', 'send', 'groups', 'sets', 'history', 'setup', 'key', 'settings', 'help'];

export const NOT_FOUND = notfound;
