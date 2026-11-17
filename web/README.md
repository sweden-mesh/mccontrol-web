# mccontrol in the browser

The same tool as the terminal one, as a static page: the key stays in the browser, the page
talks to the broker over a secure WebSocket, and nothing is sent anywhere else. Served at
mccontrol.meshcoresverige.se (Cloudflare Pages) and as a zip per release. Plan: `planning/mccontrol/web-ui-plan-20261116.md`
in the Mesh-Health workspace (sections 11 to 16 are the operator's answers).

**Status:** the shell (header, menu, display settings, messages, offline copy) is built; the
screens are placeholders.

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
| `index.html` | the page: the CSP, the shell's landmarks, `ui/boot.js`, one module script | shell (W-6) |
| `ui/` | `app.js` (shell, routing, ctx), `boot.js` (settings before paint), `prefs.js`, `appearance.js` (display settings form), `key-state.js` (key status interface), `notify.js`, `update.js`, `dom.js` (`h()`) | shell (W-6) |
| `ui/screens/` | one module per screen; `index.js` registers routes and the menu | screens (W-7, W-8, W-9, W-15, W-18, W-19) |
| `styles/` | `tokens.css` (the regional template's tokens, light/dark, colour-blind), `app.css` (shell), `phosphor.css` (W-17) | shell (W-6, W-17) |
| `fonts/`, `icon*` | IBM Plex (OFL) and the icons, copied from the regional template | shell |
| `_headers`, `manifest.webmanifest`, `sw.js`, `version.json` | the hosted copy: headers, install, offline copy | shell (W-10) |
| `lib/protocol/` | envelope v1/v2, results r1/r2/r3, broker token, registration, the MQTT client | protocol (W-3, W-4, W-16) |
| `lib/key/` | the key: `handle.js` (seed -> signing handle), storage, unlock, auto-lock, backup | key and security (W-5) |
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
connect-src 'self' wss: https://beacon.meshat.se; manifest-src 'self'; worker-src 'self';
base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'
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
  may run its own, RB-1) and Beacon's API. No fonts, images, analytics or scripts from
  elsewhere. A new origin is a CSP change and a security-review item, not a code change.
- A `<meta>` CSP cannot carry `frame-ancestors`; `_headers` does.
- `navigator.serviceWorker.register` is a Trusted Types sink: `ui/update.js` has a policy that
  accepts `sw.js` and nothing else. Any other script-URL sink needs its own narrow policy.
- `test/csp.test.js` checks all of this on every run.

## Language

The browser's first language among `sv` and `en`; Swedish when neither is there
(`i18n/i18n.js`, `pickLanguage`). The display settings (header, "Visning") override it per device. Every key exists in both
files (a test checks). Help topics and result texts from Python are English today.

## Adding a screen

1. `ui/screens/<name>.js` exporting `route` (the part after `#/`, e.g. `'nodes'`), `title` (an
   i18n key) and `render(ctx)` returning one element. Replace the route's `placeholder(...)` in
   `ui/screens/index.js` with the module; `NAV` there is the menu's order.
2. `ctx` (built in `ui/app.js`):
   - `t(key, vars)`, `lang`; `route`, `args` (`#/node/4AC61A7F` -> `['4AC61A7F']`)
   - `signal`: aborts when the screen is replaced; pass it to `addEventListener` and timers
   - `navigate('#/nodes')`
   - `notify(text, { kind: 'info'|'warning'|'error', actions: [{ label, run }] })` shows a
     message and announces it; `announce(text)` only announces. An action in a message must also
     be reachable elsewhere.
   - `key.state()` -> `{ status: 'none'|'locked'|'unlocked', publicKeyHex }`, `key.on(fn)`.
     The key stream provides the source with `provideKeySource()` in `ui/key-state.js`; the
     signing handle is not on `ctx`.
   - `prefs.current()`, `prefs.set(name, value)`, `prefs.on(fn)`; `displaySettings()` returns
     the display settings form for the settings screen.
3. The screen's first heading is an `<h1>` with an id that labels the section (see `home.js`).
   The shell moves focus to it on navigation and puts its text in the window title.
4. Its strings in `i18n/sv.json` and `i18n/en.json` under `<name>.`.
5. Colours from the tokens in `styles/tokens.css` (`--fg`, `--muted`, `--accent`, `--online`,
   `--warn`, `--danger`, `--line`, `--surface`...), never a literal, so the dark, colour-blind
   and phosphor themes hold. Status is said in words, not by colour alone.
6. Visible design work ends with the anti-AI-design review.

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

`node web/test/smoke/run.mjs` opens every route in headless Chrome, at 360 and 1280 px, in the
light and the phosphor look, and fails on any console error, uncaught page error, CSP violation,
sideways page scroll or screen without an `<h1>`. A screenshot of each lands in a new directory
under the system's temp dir (`--out DIR` to choose). The routes come from `ui/screens/index.js`,
so a new screen is covered without editing the runner; routes that take an argument are also
opened with a node id from the fixture.

It serves the directory with a small static server that sends `_headers` as Cloudflare Pages
does, so the browser enforces the deployed CSP (header and `<meta>`). Beacon's answers come from
`test/smoke/beacon-fixture.json`, times moved to now; `--live` reaches the real Beacon instead.
`--root DIR` serves another copy, such as a `scripts/web-dist.mjs` output or an unzipped
release; `--only stats,node` limits the routes.

It needs Chrome and Puppeteer: the system Chrome (`/usr/bin/google-chrome`) and Puppeteer from
`npm root -g`, the same as the headless-browser helper. It is not part of `node --test`, because
CI has no Chrome; run it before a release and after a change to a screen, the CSP or `_headers`.
