# lib/key: the signing key in the browser

| File | Holds |
|---|---|
| `keyring.js` | the API the app uses: create, import, unlock, lock, auto-lock, backup, fingerprint unlock |
| `handle.js` | seed -> frozen handle (`publicKeyHex`, `sign`, `sharedSecret`, `forget`) |
| `backup.js` | the backup file and the at-rest encryption (one format), internal |
| `prf.js` | fingerprint/face unlock through a passkey's PRF output, internal |
| `storage.js` | `indexedDbStorage(indexedDB)` and `memoryStorage()`, one record per key id |

Outside this directory, import only `keyring.js`, `storage.js` and (for tests and protocol
vectors) `handle.js`. A test fails if anything imports `backup.js` or `prf.js`.

## Choices

- **PBKDF2-HMAC-SHA256, 600 000 iterations, then AES-256-GCM.** Both run in WebCrypto: native
  speed (0.21 s per unlock in headless Chrome 150 on a server; a phone is slower), a non-extractable derived key, no vendored code on the path,
  and pycryptodome has both, so the terminal tool reads the same file. scrypt and Argon2 from
  noble resist GPU guessing better, but in pure JS on a phone they cost seconds per unlock, or
  they run at weaker settings. The KDF name and count are recorded in every file, so a later
  version can change them without breaking old files.
- **One format for the backup and for at-rest storage** (`mccontrol/keyfile.py` documents the
  fields). The additional data binds every field except `created`, so a changed header fails
  like a wrong passphrase. The passphrase is NFC-normalised before use.
- **Fingerprint/face unlock** uses HKDF-SHA256 over the passkey's 32 PRF bytes to wrap a second
  copy of the seed. It is offered only after a real sign-in returned PRF bytes and a second one
  opened the wrap. The passphrase copy is always kept.

## Threat model

| Layer | Protects against | Does not protect against |
|---|---|---|
| Passphrase encryption at rest | someone who copies the browser profile or the IndexedDB files; a sibling page on the same origin reading the store | guessing a weak passphrase offline (600 000 iterations slow the guessing but do not stop it); the minimum is 8 characters |
| Backup file | losing the key when the browser deletes storage (Safari after 7 days without a visit, a cleared profile) | a file kept next to a written-down passphrase |
| Auto-lock (5, 15 or 60 min idle, or until the tab closes) | an unlocked tab left on an unattended computer | anyone at the computer before the lock |
| `forget()` zeroing | the seed staying readable in the handle after a lock | copies inside the JS engine and noble's internals, which JS cannot zero |
| Fingerprint unlock | typing the passphrase in public | a person who can unlock the phone itself |
| CSP and same-origin code | injected third-party script | **malicious code served from this origin**: after unlock it can read the seed or sign anything. Mitigations live elsewhere (W-10: the release's `integrity.json`, the PWA's controlled updates, a zip to run locally) |

There is no server: nothing here proves to anyone else who signed in. The broker learns only
the public key and signed commands.
