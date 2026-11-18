# Vendored code

Third-party code the web app runs, checked in so nothing is fetched from a CDN at run time.
Everything here is placed by `scripts/vendor-web.sh`; do not edit these files by hand.

| Directory | Package | Version | Licence | npm tarball sha512 (registry `dist.integrity`) |
|---|---|---|---|---|
| `noble-hashes/` | `@noble/hashes` | 2.4.0 (2026-08-27) | MIT | `sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==` |
| `noble-curves/` | `@noble/curves` | 2.4.0 (2026-08-27) | MIT | `sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==` |
| `noble-ciphers/` | `@noble/ciphers` | 2.4.0 (2026-08-27) | MIT | `sha512-AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw==` |

| `maplibre-gl/` | `maplibre-gl` | 6.16.0 (2026-10-25) | BSD-3-Clause | `sha512-gApO66EMtoDZuio680RUBvskR7ahFd/NNhLN4tBAs+Y7FeT4gQV8zVFgYVMRmFxQznOEzecW19w6xOd9XjZjiA==` |

Tarballs: `https://registry.npmjs.org/@noble/<name>/-/<name>-2.4.0.tgz`. `@noble/curves@2.4.0`
depends on `@noble/hashes@2.4.0` exactly, which is the copy beside it.

## How it was made

1. Each tarball is downloaded into a fresh empty directory and its SHA-512 compared with the
   registry's `dist.integrity` above; a mismatch stops the script. Nothing in the tarball is
   run (no install scripts, no build).
2. From each package: `LICENSE`, `package.json` (it says `"type": "module"`, which node's test
   runner needs) and every compiled `.js` module except `index.js` (which only throws "import
   submodules instead"). Not copied: TypeScript sources (`src/`), `.d.ts`, README.
3. The one change: `noble-curves` imports `@noble/hashes/...` by package name, which a browser
   cannot resolve without an import map, and an import map would be an inline script the CSP
   refuses. Those import lines are rewritten to `../noble-hashes/...` (and
   `../../noble-hashes/...` under `abstract/`). No other byte differs from the tarball.

To update: change the versions and hashes in `scripts/vendor-web.sh`, run it, run
`node --test "web/test/**/*.test.js"` (the vendor test pins the bytes against Python), and
update this table. Prefer a version at least two weeks old.

## What the app uses

- `noble-curves/ed25519.js`: Ed25519 signatures (RFC 8032, deterministic) and the
  Ed25519 -> X25519 conversion for v2 (`ed25519.utils.toMontgomerySecret`, `toMontgomery`,
  `x25519.getSharedSecret`). Only `lib/key/` signs and derives with it; `lib/protocol/`
  uses it to verify r2 results against a node's public key.
- `noble-hashes/hkdf.js`, `sha2.js`: HKDF-SHA256 for the v2 and mcc3 keys, SHA-512 inside Ed25519.
- `noble-ciphers/chacha.js`: ChaCha20-Poly1305 for v2 commands, r3 results and mcc3 (commands,
  results, alive, mesh responses); plain ChaCha20 from block 1 for mcc3's mesh request (no tag).

Why not WebCrypto for these: it has no ChaCha20-Poly1305, cannot derive the X25519 key v2 needs
from an Ed25519 seed, and Safari's Ed25519 signs with added randomness (valid, but not
byte-identical to the shared test vectors). WebCrypto is still used for random bytes, PBKDF2
and AES-GCM (key storage, W-5). See `planning/mccontrol/web-browser-support-20261116.md` in the
workspace.

## MQTT: no library

mqtt.js 5.16.1 was evaluated (tarball sha512 checked, not vendored): its browser build
`dist/mqtt.esm.js` is 340 KB with readable-stream, a Buffer polyfill and ~15 bundled
dependencies, and implements MQTT 3.1.1 and 5, QoS 2, stores, reconnect strategies and more.
The app needs MQTT 3.1.1 over one secure WebSocket: CONNECT with username and password,
SUBSCRIBE at QoS 1, PUBLISH at QoS 0/1 with PUBACK both ways, PINGREQ, DISCONNECT. That is a
few hundred lines in `lib/protocol/` (W-4), all of it ours to read, against 340 KB of someone
else's. Decision: write the client; nothing to vendor.

## MapLibre (W-29d)

The standard layout's map. `LICENSE.txt` and three files of the tarball's `dist/`, unchanged:
`maplibre-gl.mjs`, `maplibre-gl-worker.mjs`, `maplibre-gl.css` (the same version and bytes as the
regional template's `static/lib/maplibre-gl/6.16.0/`). Loaded only when a map is first drawn
(`ui/standard/map.js`); its worker through the Trusted Types policy `mccontrol-map`, which accepts
that one URL. No MapLibre control is used (their icons are `data:` images, which `img-src` refuses).
The basemap is OpenFreeMap (`ui/standard/basemap.json`), the one origin it adds to `connect-src`.
