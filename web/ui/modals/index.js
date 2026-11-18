// Every modal (W-20d). Until the later waves restyle them, today's screens are shown inside the
// modal frame as they are: the old routes (#/nodes, #/node/<id>, #/key...) map onto these names
// (ui/routes.js), so old links, bookmarks and the screens' own links still land. Setup gathers
// the set-up screens as tabs (proposal §2.5, setup.js); palette.js has the
// command palette and its "run" modal (one command or set to a target).
import { registerModal } from '../modal.js';
import * as nodes from '../screens/nodes.js';
import * as node from '../screens/node.js';
import * as send from '../screens/send.js';
import * as history from '../screens/history.js';
import * as unlock from '../screens/unlock.js';
import * as help from '../screens/help.js';
import * as stats from '../screens/stats.js';
import * as notfound from '../screens/notfound.js';
import * as neighbours from '../standard/neighbours.js';
import { setupModal } from './setup.js';
import { nodeModal } from '../tiles/node.js';
import { resultModal } from '../tiles/results.js';
import { runModal } from './palette.js';

// A screen as a modal: the screen gets the ctx it always had, its route being its old one.
export const fromScreen = (screen, route = screen.route) => (ctx) => screen.render({ ...ctx, route });

// closedby 'any' where nothing typed can be lost; forms keep the default (Esc and Back only).
export const MODALS = [
  { name: 'nodes', title: nodes.title, render: fromScreen(nodes) },
  // #node/<id>: the NODE tile's view full screen (the phone's node, W-20c); beta.2's node screen,
  // with the firmware update, name, region and forget, is #nodeinfo/<id>.
  nodeModal,
  { name: 'nodeinfo', title: node.title, render: fromScreen(node) },
  { name: 'send', title: send.title, render: fromScreen(send) },
  { name: 'history', title: history.title, render: fromScreen(history), closedby: 'any' },
  resultModal,
  // W-32: "Unlock" in the title bar, Help as "?" at its right.
  { name: 'unlock', title: unlock.title, render: fromScreen(unlock), barTitle: true, barHelp: true },
  { name: 'help', title: help.title, render: fromScreen(help), closedby: 'any' },
  { name: 'stats', title: stats.title, render: fromScreen(stats), closedby: 'any' },
  // #neighbours/<id>: the standard layout's Neighbours dialog (W-29f), reading only.
  { name: 'neighbours', title: neighbours.title, render: fromScreen(neighbours), closedby: 'any' },
  { name: 'notfound', title: notfound.title, render: fromScreen(notfound, 'notfound'), closedby: 'any' },
  setupModal,
  runModal,
];

for (const m of MODALS) registerModal(m);
