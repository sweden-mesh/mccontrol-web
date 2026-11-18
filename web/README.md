# mccontrol in the browser

The same tool as the terminal one, as a static page: the key stays in the browser, the page
talks to the broker over a secure WebSocket, and nothing is sent anywhere else. Served at
mccontrol.meshcoresverige.se (Cloudflare Pages) and as a zip per release. Plan: `planning/mccontrol/web-ui-plan-20261116.md`
in the Mesh-Health workspace (sections 11 to 16 are the operator's answers).

**Status:** every screen of the plan is built: start and unlock, key and backup (QR code,
the backup file or the private key as text for a password manager, both optional,
passphrase change, fingerprint unlock, broker registration, key replacement), set up a node over
USB (Web Serial), the overview, nodes, one node, send, groups, command sets, history, statistics
(Beacon), settings and help. The firmware update is shown but flashed by hand until the firmware
admits `ota update` over the control plane.

**Redesign (W-20, `planning/mccontrol/web-redesign-proposal-20261117.md`):** wave 1 is in: one board
(NODES | NODE | STATUS + MAP + HISTORY) with the status line and the key bar, everything else in a
modal in front of it, four themes as one setting. Wave 2 filled the tiles (below, "What the tiles
do"); beta.2's other screens open as modals. Wave 3: the phone pass (360 to 412 px and landscape,
checked with fake data by `test/smoke/filled.mjs`), the strings, the old overview and menu list
removed, USB opened with DTR and RTS dropped (W-21).

## Run it

No build step and no dependencies to install. Plain HTML, CSS and ES modules.

```
python3 -m http.server -d web 8000 --bind 127.0.0.1     # then open http://127.0.0.1:8000/
node --test "web/test/**/*.test.js"                     # from the repository root (node 22)
(cd web && npm test)                                    # the same, from here
python -m mccontrol.webexport                           # rewrite lib/data/*.json and test/vectors.json
python -m pytest tests/test_webexport.py                # fails when those are stale
```

Node 22 does not take a directory as `--test`'s argument; give it the glob.
A module must be served over HTTP, not opened as a `file://` URL.

## Layout and who owns what

Each directory is one stream's area. Change another area through its owner, or in a commit
that says why.

| Directory | Holds | Stream |
|---|---|---|
| `index.html` | the page: the CSP, the status line, `<main>` (the board), the key bar, the modal `<dialog>`, `ui/boot.js`, one module script | shell (W-6, W-20) |
| `ui/` | `app.js` (shell, ctx, start), `boot.js` (theme before paint, start guard), `routes.js` (hashes, old routes), `board.js` (tile grid, status line, key bar), `board-state.js` (selection, tags), `keys.js`, `statusline.js`, `modal.js` (the modal frame), `prefs.js`, `appearance.js` (display settings form), `key-state.js` (key status interface), `notify.js`, `update.js`, `dom.js` (`h()`) | shell (W-6, W-20) |
| `ui/tiles/` | one module per board tile (`nodes`, `node`, `status`, `map`, `results`); `index.js` registers them | each tile's owner (W-20) |
| `ui/modals/` | `index.js` registers every modal (today's screens wrapped as modals); `setup.js` the Setup modal's seven tabs; `palette.js` the command palette and the `run` modal, `palette-entries.js` what it lists, `command-help.js` what each command does | shell, then Setup's owner (W-20) |
| `ui/screens/` | one module per screen of beta.2, shown inside modals (`ui/modals/index.js` registers them); beta.2's overview is gone, folded into the board (wave 3). `key-session.js` holds the page's one keyring (header state, handle, holds, unlock-and-return links); `settings-store.js` the device's thresholds and brokers per region; `node-services.js` the stores, jobs, releases and fleet for a key; `node-kit.js`/`node-kit.css` and `key-kit.js` the shared pieces | screens (W-5, W-7, W-8, W-9, W-13, W-14, W-15, W-18, W-19) |
| `styles/` | `tokens.css` (fonts, the four themes' colour tokens), `app.css` (shell: status line, board, tiles, key bar, modal), `key-screens.css` (unlock, key, set-up, settings, help) | shell (W-6, W-20), screens |
| `fonts/`, `icon*` | IBM Plex (OFL) and the icons, copied from the regional template | shell |
| `_headers`, `manifest.webmanifest`, `sw.js`, `version.json` | the hosted copy: headers, install, offline copy | shell (W-10) |
| `lib/protocol/` | envelope v1/v2, results r1/r2/r3, broker token, registration, the MQTT client | protocol (W-3, W-4, W-16) |
| `lib/key/` | the key: `handle.js` (seed -> signing handle), storage, unlock, auto-lock, backup, passphrase change | key and security (W-5) |
| `lib/store/` | IndexedDB stores per key: devices, history, groups, sets, meta | screens (W-7, W-9) |
| `lib/jobs/` | send, run a set, discover, refresh, update; checks before signing; the overview's sums; Beacon fleet reads (through `lib/stats`); the firmware release list (GitHub) | screens (W-8, W-15, W-18, W-19) |
| `lib/discovery/` | automatic discovery (`index.js`: on unlock, hourly per region, adds with undo, the broker's caps, mesh-only candidates) and the areas (`areas.js`: county, scope, IATA) | discovery (W-20a, W-20b) |
| `lib/refresh/` | the status refresh: Beacon every 15 minutes, one signed `ver` per node per day | refresh (W-20e) |
| `lib/stats/` | the Beacon client and the traffic arithmetic; the page's only Beacon | statistics (W-14) |
| `lib/qr.js` | QR code, byte mode, level M, for the key screen (no network, no library) | key screen (W-5) |
| `lib/data/` | `load.js` and the JSON exported from Python (generated: never edit) | W-2 |
| `lib/bytes.js` | hex, UTF-8, concat | anyone, carefully |
| `i18n/` | `i18n.js`, `sv.json`, `en.json` | shell (W-6); every stream adds its keys |
| `vendor/` | pinned third-party code, see `vendor/VENDOR.md` | key and security |
| `test/` | `node --test` files and `vectors.json` (generated) | each stream its own `*.test.js` |

## Module boundaries

- **The raw seed never leaves `lib/key/`.** `lib/key/handle.js` turns 32 seed bytes into a
  frozen handle: `publicKeyHex`, `sign(bytes)`, `sharedSecret(nodeKeyHex)`, `forget()`. Storage
  and unlock (W-5) hand out handles. Protocol functions take a handle as their first argument;
  UI code passes it through and never reads or holds a seed, a passphrase-derived key or a
  shared secret. Only `lib/key/` signs or derives; `lib/protocol/` may import
  `vendor/noble-curves/` to verify a node's signature (r2), with a public key only.
- **`lib/` has no DOM.** Everything under `lib/` runs in node for the tests: no `document`,
  no `window`, no `localStorage`. Browser-only storage (IndexedDB) lives behind a small module
  that takes the database as a parameter, so a test can pass a fake.
- **Behaviour comes from `lib/data/`.** The command table, cautions, deny list, result codes
  and help, facts, firmware capabilities, brokers and protocol constants are exported from the
  Python package; a JS port reads the JSON and never restates a list. Where JS ports a rule
  (the deny list's matching, `firmware.admits`), `test/vectors.json`'s `checks` pin it to the
  Python answers.
- **Byte-identical with Python.** `test/vectors.json` holds fixed inputs and Python's exact
  outputs: v1 and v2 envelopes, the v2 key steps, r1/r2/r3 results (including forged ones),
  the broker token, the registration line and the screens' checks. A JS protocol function is
  done when it reproduces every vector. Its seeds are SHA-256 of fixed phrases, never a real
  key.
- **One store per key.** Everything stored (devices, history, settings that belong to a key)
  is keyed by the public key, so profiles can come later without a migration (plan §12.2).

## Naming and style

- Files and directories: lower case, `-` between words (`node-list.js`). Tests:
  `test/<area>-<thing>.test.js`.
- ES modules only, named exports, no default exports. Two-space indent, semicolons, single
  quotes. No classes where a function and a frozen object will do.
- Functions are named for what they return or do (`buildV1`, `parseResult`, `refusal`),
  matching the Python names where one exists (`envelope.build_v2` -> `buildV2`).
- Errors: throw `Error` with a sentence a person can read; the UI shows `message`.
- Strings shown to a person go through `t('area.key')`; never a literal in a screen.

## The Content Security Policy

`index.html` carries it as a `<meta>`, so a self-hosted copy has it too; `_headers` sends the
same policy as a header on Cloudflare Pages, plus `frame-ancestors 'none'`, HSTS, nosniff,
`Referrer-Policy: no-referrer` and a `Permissions-Policy` that allows Web Serial and Web Bluetooth
for this origin only (`test/shell-deploy.test.js` keeps the two in step):

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
connect-src 'self' wss: https://beacon.meshcoresverige.se https://beacon.meshcore-jkp.se https://api.github.com https://tiles.openfreemap.org; manifest-src 'self';
worker-src 'self';
base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types mccontrol-sw mccontrol-map
```

What it means for code:

- **No inline script or style, no `on*=` attributes, no `style=` attributes.** Every script is
  a file loaded as a module; every style is in a `.css` file. Set styles with classes.
- **No `eval`, `new Function`, or string `setTimeout`.**
- **No HTML strings.** Trusted Types is enforced where supported, so `innerHTML`,
  `outerHTML`, `insertAdjacentHTML` and `document.write` throw. Build with `ui/dom.js`'s
  `h(tag, attrs, ...children)`, which sets text as text; attach listeners with
  `addEventListener`.
- **No third-party requests.** `connect-src` allows this origin, any `wss:` broker (a region
  may run its own, RB-1), Beacon's API (`lib/stats/beacon.json`) and GitHub's API for the firmware
  release list (`lib/jobs/releases.json`). No fonts, images, analytics or scripts from
  elsewhere. A new origin is a CSP change and a security-review item, not a code change.
- A `<meta>` CSP cannot carry `frame-ancestors`; `_headers` does.
- W-29d widened it for the standard layout's map, and only for that: `https://tiles.openfreemap.org`
  in `connect-src` (the regional template's basemap: styles, vector tiles, fonts and sprites, all
  fetched by MapLibre; `ui/standard/basemap.json`) and the Trusted Types policy `mccontrol-map`
  (MapLibre's own worker, `vendor/maplibre-gl/maplibre-gl-worker.mjs`, and no other URL).
- `navigator.serviceWorker.register` is a Trusted Types sink: `ui/update.js` has a policy that
  accepts `sw.js` and nothing else, created lazily on the first registration (W-20k). Any other
  script-URL sink needs its own narrow policy, created where it is used, never at module load.
- `test/csp.test.js` checks all of this on every run.

## Language

The browser's first language among `sv` and `en`; Swedish when neither is there
(`i18n/i18n.js`, `pickLanguage`). The display settings (Setup, "Visning") override it per device. Every key exists in both
files (a test checks). Help topics and result texts from Python are English today.

## Two layouts (W-29)

`html[data-layout]`: `standard` ("list and detail", the default for a new user, W-29h, operator
2026-11-18) or `retro` (the board below). One setting, `layout`, in Setup's display tab and on the
unlock gate's first start; and a clear button top right in both: the standard layout's shows Font
Awesome's `terminal` icon and goes to the retro board, the board's (in the status line) shows
`table-columns` and comes back. The icons' SVG paths are inlined (`ui/standard/icons.js`): no Font
Awesome CSS, script or font, no new origin. Font Awesome Free icons are CC BY 4.0, Copyright 2026
Fonticons, Inc. (fontawesome.com); Help's "About" says so too.

The standard layout (`ui/standard/`, `styles/standard.css`): a header (app name, area, companion,
Setup, Help, Log out, the switch), the node list with a live search over name and key (case and
diacritics ignored, a hex prefix matches the key; the count shown, Esc clears; W-29g), and the
selected node: its name and what it is, then tabs. Overview is four panels edge to edge with 1 px
shared borders and no space between them or against the list and the top panel (W-29a): Status
(state and reason, firmware, battery, uptime, Neighbours, Statistics), Location (the map), Send a
command (the NODE tile's command line) and Recent results. Commands, History, Firmware and Settings
are the screens the board opens as modals (send form, history, `node.js`'s firmware block, facts and
edit form). Footer: command server, key, registration, Beacon status. On a phone the list and the
node take the screen in turn. It has its own colours, `scheme` dark (the default) or light (W-29b,
the setting and not the OS), and `colorblind` (W-29c, `html[data-colorblind]`): blue / yellow /
orange that also differ in lightness, besides the shapes ● ▲ ✕ ○ every state has anyway. The retro
board keeps its own `theme`.

- **Map** (`ui/standard/map.js`, W-29d): MapLibre 6.16.0 (vendored) on the regional template's
  basemap, OpenFreeMap's `dark` or `liberty` style by the scheme. The template has no tile proxy
  of its own, so this is the one origin added. Attribution under the map. Markers are our own
  buttons with the status shapes; Overview shows the node and its neighbours, with no node
  selected the map frames the owner's nodes.
- **Neighbours** (`#neighbours/<id>`, `ui/standard/neighbours.js`, W-29f): each neighbour's name and
  key prefix, SNR last and average over the stored `neighbors` replies, RSSI (reported by neither
  source, so it says so), when heard, direct (in the node's reply) or Beacon only, distance, and
  Select for the owner's own node. Reading only.
- **Log out** (W-29e): asks, then locks the key; the unlock gate takes over.

## The board, the modals and the keys

The board is the page and is never navigated away from (W-20c). Everything else is a modal in front
of it (W-20d). The hash names the open modal: `#node/4AC61A7F`, `#setup/key`, `#help/codes`; an empty
hash is the board alone. Back closes a modal; closing one walks back to the board.

### The unlock gate (W-28b)

With no key, or a locked one, nothing behind the unlock modal is shown or usable: `ui/boot.js` puts
`html[data-gate]` before the first paint, `ui/app.js` keeps it while the key is not unlocked and
makes the status line, `<main>` and the footer inert. Only `#unlock` (make, import or unlock) and
`#help` (a link on the unlock screen) can be open; any other address is kept and opened once the
key is unlocked. The gate's dialog has no close button and ignores Esc. Locking, by hand or by
auto-lock, brings it back. So no tile, screen or action has a "the key is locked, unlock" branch of
its own; a job that finds the key locked mid-way says only that. The unlock dialog (W-32) has
"UNLOCK" and a "?" for Help in its title bar (`registerModal`'s `barTitle`, `barHelp`), the Unlock
button beside the field (below it on a phone), then Show passphrase, then Forgot the passphrase.

The command field's suggestions (W-33c, `ui/command-combo.js`) are an own listbox in the theme
(combobox pattern), not a `<datalist>`, in NODE, the standard layout and the send form; they list
only what the targets' known firmware admits (W-33d), everything with "version unknown" otherwise.
STATUS's times step down to the tile's width (W-33a, `kit.js` `fitTimes`).

### The ctx

`ui/app.js` builds one shared ctx; tiles and modals each get it with their own additions:

- `t(key, vars)`, `lang`
- `navigate(hash)`: `'#node/AB'`, `''` for the board; the old `'#/route'` forms still work
- `notify(text, { kind: 'info'|'warning'|'error', actions: [{ label, run }] })`, `announce(text)`.
  An action in a message must also be reachable elsewhere.
- `key.state()` -> `{ status: 'none'|'locked'|'unlocked', publicKeyHex }`, `key.on(fn)`. The handle,
  holds and the full status are `ui/screens/key-session.js`'s (`currentHandle()`, `holdKey()`,
  `keyStatus()`, `onKeyStatus(fn)`); the handle is never on ctx.
- `prefs.current()`, `prefs.set(name, value)`, `prefs.on(fn)`; `displaySettings()` the theme and
  language form
- `modal.open(name, ...args)`, `modal.close()`, `modal.current()`

The stores, jobs, rules and Beacon come from `ui/screens/node-services.js` (`withServices` in
`node-kit.js`), as for the screens: a tile imports them, ctx does not carry them.

### The board's tiles

Five mount points, fixed by `TILES` in `ui/board.js`: `nodes`, `node`, `status`, `map`, `results`.
The grid (`styles/app.css`): one column on a phone (under 45em: NODES, HISTORY, MAP, STATUS; the NODE
tile is not shown and a node opens full screen as the `node` modal); NODES | NODE with the others
below from 45em; NODES | NODE | STATUS + MAP + HISTORY from 1100 px; from 1600 px HISTORY runs under
NODE and the right column. From 1100 px the board fills the window and each tile body scrolls.

A tile is a module in `ui/tiles/` exporting:

```js
export const id = 'nodes';            // one of TILES
export const title = 'tile.nodes';    // i18n key: the name on the tile's top border
export function render(ctx) { return element; }   // called once per draw (and on a language change)
```

`ui/tiles/index.js` registers it with `registerTile()`. The board puts the element in the tile's
`<section>` (labelled by its `<h2>` title) and catches a throw, so one broken tile leaves the
others standing. A tile's ctx is the shared one plus:

- `signal`: aborts when the board is drawn again (language change). Everything below that
  subscribes is unsubscribed by it; pass it to your own `addEventListener` calls and timers.
- `tile.setTitle(extra)`: the title becomes "NODES 4 · 1 needs attention" (the name stays).
- `board.selected()`, `board.select(id)` (on a phone this opens `#node/<id>`), `board.tagged()`,
  `board.toggleTag(id)`, `board.setTagged(ids)`, `board.clearTags()`, `board.on(fn)`:
  `fn({ selected, tagged, what })`. The store is `ui/board-state.js`; ids are upper-case control ids.
- `keys.bind(spec, { label, run, bar, order })`: see Keys below; unbound with the signal.
- `modal.on(fn)`: `fn(current)` when a modal opens, changes or closes.
- `narrow()`: true in the phone layout.

Rows: `.rows` / `.row` are `--row` tall (28 px on a desktop, 44 px on a phone or a coarse
pointer) at `--tile-text`. Status is a glyph and a word, never colour alone: `GLYPH` in
`ui/statusline.js` (`●` ok, `▲` needs attention, `✕` refused, `?` not known). An alert line takes
the `.alert` class (inverse in Amber and Green).

### What the tiles do (wave 2)

- **NODES** (`ui/tiles/nodes.js`): one row per node, refused or forged first, then what needs
  attention, not known, ok; each on one line: name, firmware, last heard (no region, W-33g) and the severity
  mark and tint, no status text (W-28c: the reason is NODE's); no battery column (W-26f). A click selects (on a phone:
  the node full screen; the selection is remembered by the browser), the box tags. Keys in the list: ↑ ↓ Home End, Enter selects, Space tags; `/` searches.
- **NODE** (`node.js`, `node-view.js`): facts with their age, 24-hour sparklines from Beacon
  (battery, airtime sent, noise floor), buttons for details, statistics and history (W-28e), and the command
  area at the bottom: two fixed rows, the line with the road (auto, MQTT, mesh, a segmented switch of
  three radios in the button style, W-28d: the node's last
  choice, kept as the device's `road`, else the mesh while a companion is connected, else MQTT;
  `startRoad` in `lib/jobs/road.js`, W-26b, W-26c) and the companion's
  line when the road may take the mesh. A reply shows only in HISTORY (W-23g); what is wrong with a
  command tints the field and is its description, Send off when it cannot go (W-23h). It sends to the tagged nodes when any are tagged, else to this one,
  through `lib/jobs` with the checks before signing. The `node` modal (`#node/<id>`) is the same
  view full screen; beta.2's node screen is `#nodeinfo/<id>`, "Firmware, name and region" (W-26h): name, region,
  notes and forget at the top, facts, the firmware update, one "Set/update region" (the shipped
  `add-scope` steps; the owner's own sets stay in the palette and Setup, W-26i) and "All history"; no
  Send and no results, which the board has.
- **HISTORY** (`results.js`, RESULTS until W-25d): the selected node's answers, refusals and silences,
  new ones first, kept new until opened or marked seen (meta `resultsSeen` per key); with no node
  selected every node's, the title saying "all nodes". How many are new shows in NODE
  ("2 new" first on its meta line, a link to the node's history; W-26g, NODES until then), not in the title. Running jobs as bars; the `result` modal shows one.
- **STATUS** (`status.js`): the command server (W-28a, `broker-source.js`: once the key is unlocked
  the page signs in to each command server and closes again, no publish; "connecting…", then
  "connected" or "unreachable (why)", the host in the tooltip; Test), key (Lock), registration, companion (the word opens the
  chooser, `companionChooser` in `ui/screens/road-kit.js`, W-23a), status
  refresh and discovery, each with its action; sets the status line's `broker`.
- **MAP** (`map.js`): the owner's nodes on the county outlines (`ui/tiles/se-lan.json`, the
  regional template's Natural Earth outlines, public domain, drawn at ~250 m instead of its 1 km by
  `scripts/county-outline.py`, W-33f), shape = status, Beacon's neighbour
  links and the area's other repeaters (`/nodes?iatas=<region>&neighbors=true`); NODES is
  the text alternative (W-26e removed "As a list"). Under the outlines, faintly, lakes and the coast (`ui/tiles/se-water.json`,
  Natural Earth 1:10m, made by `scripts/water-outline.py`, W-23c). No map tiles, no new origin.
  The frame is the owner's own nodes (`mapFrame` in `data.js`, W-25c), at least 2 km across rather
  than the region's 30 (W-26a: nodes 300 m apart showed as one dot); the region's nodes frame it
  only when none of the owner's has a position. A later draw wins over an earlier one still reading.

What the tiles share besides the selection is `ui/tiles/sources.js` (no DOM): `provideSource(name,
{ state, on, run, undo })` for STATUS's `broker`, `registration`, `refresh` and `discovery` lines
(`ui/tiles/automation-sources.js` provides `refresh` and `discovery` from `ui/automation.js`, and
`registration` from `ui/screens/key-register.js`); `reportBroker`;
`startJob({ label })` for HISTORY' bars; `dataChanged(what)` / `onDataChanged(fn)` when the stores
changed (a send, discovery, Beacon). The arithmetic is `ui/tiles/data.js` (`test/tiles-data.test.js`).
Styles: `styles/tiles.css`; each tile body is a size container, so columns drop with the tile's width.

### The status line

`setStatusItem(name, { word, state, href, label })` in `ui/statusline.js`, for `broker`, `key`,
`area`, `clock`. The shell sets `key` and `clock`, and a "connecting…" `broker` until its owner
(the STATUS tile) sets it; `area` is no longer set (W-33g: the area is Setup's alone). Hidden on a phone: clock.

### Modals

`ui/modal.js`; register in `ui/modals/index.js` (or from a tile's own module):

```js
registerModal({ name: 'result', title: 'result.title', render(ctx) { return element; }, closedby: 'any' });
openModal('result', id);              // anywhere: sets #result/<id>; Back closes it
closeModal();                         // back to the board
```

- `name` is the hash's first part; the rest arrives as `ctx.args` (decoded). `ctx.route` is the
  name, `ctx.signal` aborts when the modal closes or shows something else, `ctx.close()` closes it.
- The content's first heading names the dialog (`aria-labelledby`) and the window title.
- `closedby: 'any'` lets a click outside close it (help, a result, nothing typed to lose); the
  default `'closerequest'` is Esc and Back only, for anything with a form.
- One native `<dialog>`, `showModal()`: the browser gives focus, the inert board, Esc and the back
  gesture. Do not add a focus trap, `role="dialog"`, `aria-modal` or an Esc handler. A
  confirmation inside a modal is its own small `<dialog>` (node-kit's `.dlg`), opened over it.
- On a phone the dialog is a full-screen sheet. The only motion is its 120 ms fade, inside
  `prefers-reduced-motion: no-preference`.

Old routes map onto the board and the modals (`ui/routes.js`, `legacyHash`): `#/nodes` -> `#nodes`,
`#/node/<id>` -> `#node/<id>`, `#/send`, `#/history`, `#/help`, `#/unlock`, `#/stats` likewise;
`#/key`, `#/setup`, `#/settings`, `#/groups`, `#/sets` -> `#setup/key`, `#setup/node`,
`#setup/settings` (Setup's alias for `#setup/area`), `#setup/groups`, `#setup/sets`; `#/` -> the board; an unknown one -> `#notfound`.
The old screens' own links and `navigate()` calls therefore keep working inside the modals.

### Keys

`bindKey(spec, { label, run, bar, order })` in `ui/keys.js` (a tile uses `ctx.keys.bind`). `spec`
is a `KeyboardEvent.key` (`','`, `'?'`, `':'`, `'/'`, `'Enter'`) or `'ctrl+k'` (Ctrl or Cmd). A
later binding of the same spec wins until it is unbound. Keys do nothing while focus is in a field
or a modal is open. `bar: true` puts it in the key bar (on a phone: the big buttons at the bottom),
by `order`. The shell binds `,` Setup (80) and `?` Help (90), and through `bindPaletteKeys(t)` the
palette's `:` (70, "Commands") and `ctrl+k`.

### Setup and the command palette

Setup (`ui/modals/setup.js`) has seven tabs, each its own address: `#setup/key` (public key, copy,
QR, broker registration, lock and auto-lock, backup, private key behind the passphrase,
passphrase, fingerprint, replace), `#setup/node` (put the key on a node: USB, and the lines to type,
each with a Copy button, W-20h), `#setup/area` (the county, a region's own broker, the companion
radio), `#setup/groups`, `#setup/sets` (what a set is, when to use one, the shipped example; every
step says what it does, W-20i), `#setup/warnings` (battery, not heard, mesh road), `#setup/display`.
`TABS` lists them; `ALIASES` maps the old names (`settings` -> `area`, `setup` -> `node`).

Registration runs by itself (`ui/screens/key-register.js`): when a key is unlocked (made, imported
or unlocked) that this browser has not registered with every broker it sends to, once per page,
one signed publish per broker and nothing on the air. `registration()`/`onRegistration(fn)` give
`{ state: 'none'|'running'|'ok'|'partial'|'failed', hosts: [{ host, state, detail, at }] }`;
`registerNow()` is the "Register again" button (the Key tab; STATUS may offer it too).
`brokerProblem(t, message)` / `brokerText(t, message)` turn a broker error from `lib/protocol`
("cannot reach wss://… (1006)") into the page's words and a next step; use it wherever a broker
error reaches a person.

The palette (`:` or Ctrl+K on the board) is a non-modal `<dialog popover>` with a combobox: every
Setup tab, Help, History, lock or unlock, every command line of the exported table with what it
does (`palette.cmd.<command>` strings, one per table entry in both languages: a test fails when the
table gains a command without them), the sets, the groups and "every node in a region". It never
signs: a command or a set opens `#run/cmd/<target>/<command>` or `#run/set/<target>/<set>`, the old
send form with its checks and confirmations (a region-wide send asks, naming the region and the
count). `<target>` is `n:ID,ID`, `g:<group>`, `r:<region>` or `-`; the palette takes the tagged
nodes, else the selected one.

### Discovery, the area and the status refresh

`ui/automation.js` runs them for the page (W-20a, W-20b, W-20e; the shell starts it once). It
follows the key: Beacon is read with any key (it needs none), discovery and the daily `ver` run only
while the key is unlocked. The logic is in `lib/discovery/` and `lib/refresh/` (no DOM, tested with a
fake clock, fake jobs and a fake Beacon); everything they keep is per key, in the key's meta store.

What the STATUS tile reads:

```js
import { automationState, onAutomation, lookNow, refreshNow, undoDiscovery } from '../automation.js';
const s = automationState();          // frozen; onAutomation(fn) -> unsubscribe, fn(s) on every change
s.owner, s.unlocked                   // no owner: no key, nothing runs
s.area                                // { scb, county, scope, iatas, label: 'Jönköpings län · se-jkp' } | null
s.discovery.running                   // and .progress { region, elapsed, total, answered } while it runs
s.discovery.lastRun, .nextRun         // epoch ms or null (nextRun null: locked, stopped or nowhere to look)
s.discovery.needsArea                 // no area and no node: "choose an area" (link '#setup/area')
s.discovery.last                      // { at, regions, added: [{ node, name, region }], known, ignored,
                                      //   rejected: [{ node, region, reason: 'forged'|'keyChanged' }],
                                      //   failed: [{ region, code, detail }], skipped: [{ region, reason: 'recent'|'cap' }], undone }
s.discovery.canUndo                   // undoDiscovery() removes them and keeps them out
s.refresh.running                     // 'beacon' | 'ver' | null
s.refresh.beacon                      // { lastRun, nextRun, updated, unknown, failed, error }
s.refresh.ver                         // { lastRun, nextRun, sent: [{ node, name, ok, code }],
                                      //   skipped: [{ node, name, reason: 'notHeard'|'budget'|'locked' }] }
s.changed                             // 'key'|'area'|'discovery'|'refresh'|'nodes' ('nodes': reload the list)
await lookNow();                      // "Look now": skips the cooldown, not the broker caps
await refreshNow();                   // Beacon now, then `ver` where due
```

Rules it keeps: discovery at most once an hour per region (`get autoreply` then `get name`, 2 of the
broker's 5 broadcasts an hour per region), "Look now" at most twice an hour per region, at most 8
regions an hour per key; the regions are the area's IATA codes and those of every node in the list.
It never adds a node whose answer failed its signature or whose key changed, nor one removed with
undo. The daily `ver` goes over MQTT only, never to a mesh-only node, never to one not heard on MQTT
in the last 2 hours, and never when the node has had 5 or more commands in the last hour (half its
10 are the owner's). A new firmware on Beacon makes it due at once. Beacon's values are stored on the
device as `fleet` (battery, seen, firmware, airtime, noise floor, uptime, neighbours and their
Beacon ids, position, IATA codes); a node Beacon does not know has its fleet cleared.

The area: `areaPicker(ctx, { id })` in `ui/area.js` (a county dropdown showing the scope, saved with a
button because it starts a discovery), mounted in Setup's `area` tab (`#setup/area`); the status
line no longer shows it, nor does MAP's title (W-33g). The table is `lib/data/areas.json`, exported from `mccontrol/areas.py`,
which is the regional template's counties (`tests/test_areas.py` compares it with a template
checkout). Mesh-only nodes: `meshCandidates()` lists the repeaters in the connected companion's
contacts that are not in the list, `addMeshNode(c)` adds one as mesh-only in the area. Setup's area
tab finds them (W-24, `ui/screens/mesh-find.js`): `findMeshNodes(geo)` adds Beacon's repeaters that
are not observers and lie inside the county's outline (`lib/discovery/mesh-candidates.js`; by
position, since Beacon's IATA is only where a node was heard), sending nothing; `checkMeshNode(c)`
(`jobs.checkMeshNode`) sends one signed `ver` on `meshcore/mesh/<key>/cmd` through the companion,
only on the owner's press, and adds the node as mesh-only when it answers.

Strings: `area.*`, `disc.*`, `refresh.*`.

### Themes

One setting, `html[data-theme]`: `amber` (the default), `green`, `dark`, `light` (W-20f). `ui/boot.js`
applies it before the first paint and moves old settings over once (a terminal screen wins, then
light or dark, else amber; the colour-blind and reduced-motion keys go). Colours only from the
tokens in `styles/tokens.css` (`--fg`, `--muted`, `--accent`, `--online`, `--warn`, `--danger`,
`--alert-bg`/`--alert-fg`, `--line`, `--field-border`, `--surface`, `--bg`), never a literal.
Amber and Green are mono (IBM Plex Mono); Dark and Light are IBM Plex Sans. Status colours are
colour-blind safe in all four; `test/shell-themes.test.js` checks AA contrast for every text token.

### Strings and review

Strings in `i18n/sv.json` and `i18n/en.json` under the tile's or modal's name. Visible design work
ends with the anti-AI-design review.

## Start errors

`start()` in `ui/app.js` catches its own failure and shows "mccontrol could not start in this
browser" with the reason in a read-only field in `<main>`. `ui/boot.js` does the same for a module
that fails to load or to run before `app.js` has started (`html[data-started]`), so a browser that
refuses something never shows a blank page (W-20k). The service worker's Trusted Types policy is
made when the worker registers, not when `ui/update.js` loads: a browser that refuses it loses only
the offline copy.

## Vendored code

`vendor/VENDOR.md` lists each package, version, licence and tarball hash, and how it was
copied (`scripts/vendor-web.sh`). The MQTT client is our own (no library); the reasons are there.

## Deploy and releases

`scripts/web-dist.mjs --out DIR --version V --commit SHA` makes the deployable copy: `web/`
without `test/`, `package.json` and this file, the version stamped into `sw.js` and
`version.json`, and `integrity.json` with the SHA-256 of every file.
`.github/workflows/web-deploy.yml` runs the tests on every push and pull request, deploys that
copy to the Cloudflare Pages project `mccontrol` on a push to `main` (only when the repository
variable `DEPLOY_ENABLED` is `true`; secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`),
and for a tag `web-v*` attaches `mccontrol-<tag>.zip`, its `.sha256` and the `integrity.json`
to that tag's GitHub release.

The offline copy (`sw.js`) installs a release only when every file matches `integrity.json`,
keeps serving the running release, and shows "a new version is available" with a button when
another one has installed; it switches only when the owner presses it. A copy with
`version.json` = `dev` (this directory as it is) registers no service worker.

## Smoke test

`node web/test/smoke/run.mjs` opens the board and every modal (with sample arguments: a node id
from the fixture, help topics, the unlock variants, every Setup tab) in headless Chrome, at 360 and
1280 px, in all four themes, and the board alone at 390, 1100 and 1600 px; the standard layout
(W-29) in dark, light and colour-blind both ways at 360, 390, 1280 and 1600 px, every modal in front
of it once; the unlock gate with no key and with a locked one (W-28b); the layout switch both ways
and Log out (W-29e). It seeds a fake key and unlocks it in each page, with a WebSocket that reaches
no broker, and answers the basemap's requests with a one-layer style, so it needs no network. It fails on any console
error, uncaught page error, CSP violation, sideways page scroll, a board without the tiles that
width shows, or a modal that did not open labelled by its heading. Then it checks the frame: old
routes land where `legacyHash` says, `,` and `?` open Setup and Help, Back, Esc and the close
button return to the board, and the start (W-20k): with Trusted Types refusing every policy the
board still starts and says the offline copy failed; with the strings or `ui/app.js` failing to
load the page shows the start error. A screenshot of each lands in a new directory under the
system's temp dir (`--out DIR` to choose).

`node web/test/smoke/filled.mjs [--shots]` also draws the standard layout with the fake data in its
four looks at 360, 390, 1280 and 1600 px (the list, a node, each tab at 1280, the Neighbours dialog,
the live search; nothing sideways, cut off or overlapping, the Overview panels edge to edge), and
draws the board with fake data (`test/smoke/fake.mjs`: an
invented key stored locked, eight invented nodes, their history and Beacon answers; no broker, the
WebSocket is a stub) in all four themes at 360, 390 and 412 px, landscape 740 x 360 and 1280 px, and
checks what only a filled board shows: rows and buttons at least 44 px on a phone, nothing sideways,
nothing cut off or on top of another control, room under the fixed key bar, the node sheet's command
line at the bottom. `--shots` adds the beta notes' screenshots.

USB (W-21): `lib/mesh/serial.js`'s `openQuiet` drops DTR and RTS right after `port.open`, for the
companion and for Setup's node tab, because on an ESP32-S3's native USB they reset the board into a
boot loop. The chip resets while RTS is 1 and DTR 0, so RTS is dropped first and DTR after, in two
`setSignals` calls (W-25b; dropping DTR first passed through that state and reset the V4). On the
bench, `?usbsignals=dtr0rts0|dtr0rts0-old|dtr1rts0|dtr0rts1|dtr1rts1|none` in the address picks
another (`dtr0rts0-old`: both in one call, as beta.3 to beta.6; `none`: the browser's defaults,
which is all meshcore.js, the official web clients' library, does: `open({ baudRate: 115200 })`, no
`setSignals`, app start at once).

App start over USB waits up to 20 s (the V4 answered 7.4 s after the reset): every 0.5 s after the
first 1.5 s, but only every 2 s once the board's boot log has been heard, and a SELF_INFO after the
first (one per app start queued during the boot) is dropped, never taken as the next command's answer.

When the board restarts anyway (W-25b), an ESP32-S3 on native USB leaves the bus and comes back as a
new device, so the opened port dies: its read fails and `disconnect` fires. `connectSerial` then lets
go of it and looks every 250 ms in `navigator.serial.getPorts()` (ports already granted, so no new
click) for the same USB vendor and product, reopens it after 300 ms, and app start begins again; up
to 15 s, and at most 3 restarts per connection. Meanwhile the companion line says "The companion
restarted, reconnecting…". With `?usbdebug=1` in the address a box in the top corner records every
step (open, signals, bytes in and out as hex and text, lost, retries, reopened) with the milliseconds
since the first, open from the start, and "Copy" puts it on the clipboard (`lib/mesh/usblog.js`, `ui/usb-debug.js`).
A board that sends bytes (its ROM boot log) but frames no answer within those 20 s is said to run the Bluetooth
or Wi-Fi companion build: a companion build has one interface (`examples/companion_radio/main.cpp`:
`BLE_PIN_CODE` gives `SerialBLEInterface`, else `ArduinoSerialInterface`), so it never answers over
USB (the operator's V4 capture, 2026-11-17).

The modals come from `ui/modal.js`'s registry, so a new modal is covered without editing the runner.
`--only board,help` limits the hashes. Firefox is not run: Puppeteer would need a Firefox download
(about 90 MB), which is the operator's call; the guarded paths are covered in Chrome by forcing
the failures, and in `test/shell-boot.test.js` and `test/shell-update.test.js`.

It serves the directory with a small static server that sends `_headers` as Cloudflare Pages
does, so the browser enforces the deployed CSP (header and `<meta>`). Beacon's answers come from
`test/smoke/beacon-fixture.json`, times moved to now; `--live` reaches the real Beacon instead.
`--root DIR` serves another copy, such as a `scripts/web-dist.mjs` output or an unzipped release.

It needs Chrome and Puppeteer: the system Chrome (`/usr/bin/google-chrome`) and Puppeteer from
`npm root -g`, the same as the headless-browser helper. It is not part of `node --test`, because
CI has no Chrome; run it before a release and after a change to the board, a modal, the CSP or
`_headers`.
