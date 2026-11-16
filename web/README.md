# mccontrol in the browser

The same tool as the terminal one, as a static page: the key stays in the browser, the page
talks to the broker over a secure WebSocket, and nothing is sent anywhere else. Served from
sweden-mesh GitHub Pages and as a zip per release. Plan: `planning/mccontrol/web-ui-plan-20261116.md`
in the Mesh-Health workspace (sections 11 to 16 are the operator's answers).

**Status:** the skeleton. The start screen is a placeholder.

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
| `index.html` | the page: the CSP, the shell's landmarks, one module script | shell (W-6) |
| `ui/` | `app.js` (language, routing), `dom.js` (`h()`), `app.css`, `screens/` | shell (W-6), screens (W-7, W-8, W-9, W-15, W-18, W-19) |
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

`index.html` carries it as a `<meta>` (GitHub Pages cannot set headers):

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
- A `<meta>` CSP cannot carry `frame-ancestors`; clickjacking is W-12's to handle.
- `test/csp.test.js` checks all of this on every run.

## Language

The browser's first language among `sv` and `en`; Swedish when neither is there
(`i18n/i18n.js`, `pickLanguage`). A setting may override it (W-6). Every key exists in both
files (a test checks). Help topics and result texts from Python are English today.

## Adding a screen

1. `ui/screens/<name>.js` exporting `route` (the part after `#/`, e.g. `'nodes'`) and
   `render(ctx)` returning one element. `ctx` is `{ t, lang, args }`; `args` are the path
   segments after the route (`#/node/4AC61A7F` -> `['4AC61A7F']`). Later streams extend `ctx`
   (the key handle, the data, the store) in `ui/app.js`.
2. Add it to `SCREENS` in `ui/screens/index.js`.
3. Its strings in `i18n/sv.json` and `i18n/en.json` under `<name>.`.
4. Give its heading an id and label the section with it (see `home.js`).
5. Visible design work ends with the anti-AI-design review.

## Vendored code

`vendor/VENDOR.md` lists each package, version, licence and tarball hash, and how it was
copied (`scripts/vendor-web.sh`). The MQTT client is our own (no library); the reasons are there.
