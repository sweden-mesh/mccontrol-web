# mccontrol-web

mccontrol in the browser, for the people who run MeshCore Observer repeaters: sign a command
with a key kept in the browser, send it to one repeater or several over MQTT, or over the mesh
through your own companion radio (USB or Bluetooth), and see what came back, with a history per
node. Live at [mccontrol.meshcoresverige.se](https://mccontrol.meshcoresverige.se).

A static page: plain HTML, CSS and ES modules, no build step, no server of its own, no analytics.
The key is made or imported in the browser, stored encrypted under a passphrase, and never sent
anywhere except inside a signature or a backup file you save yourself.

What it is not: not the terminal tool, not a command server, not firmware. It never changes a repeater's
key, identity or radio (the deny list keeps those to the serial cable).

![The standard layout: the node list and one node's overview](docs/screenshots/standard-dark-1600.png)

## Two layouts

**Standard** (the default): a list of your nodes and one node's detail, in dark or light, with a
colour-blind mode.

| Light | Commands | History | Phone |
|---|---|---|---|
| [![](docs/screenshots/standard-light-1600.png)](docs/screenshots/standard-light-1600.png) | [![](docs/screenshots/standard-dark-1280-commands.png)](docs/screenshots/standard-dark-1280-commands.png) | [![](docs/screenshots/standard-dark-1280-history.png)](docs/screenshots/standard-dark-1280-history.png) | [![](docs/screenshots/standard-dark-phone.png)](docs/screenshots/standard-dark-phone.png) |

**Retro**: a board of tiles (NODES, NODE, STATUS, MAP, HISTORY) with a command palette, in
amber, green, dark or light. Settings switch between the two.

![The retro board in amber](docs/screenshots/retro-amber-1600.png)

| Palette | Companion | Result | Node details | Neighbours |
|---|---|---|---|---|
| [![](docs/screenshots/retro-palette.png)](docs/screenshots/retro-palette.png) | [![](docs/screenshots/retro-companion-chooser.png)](docs/screenshots/retro-companion-chooser.png) | [![](docs/screenshots/retro-result.png)](docs/screenshots/retro-result.png) | [![](docs/screenshots/retro-node-details.png)](docs/screenshots/retro-node-details.png) | [![](docs/screenshots/standard-dark-neighbours.png)](docs/screenshots/standard-dark-neighbours.png) |

Setup: [key](docs/screenshots/retro-setup-key.png) · [node](docs/screenshots/retro-setup-node.png) ·
[command server](docs/screenshots/retro-setup-connections.png) · [groups](docs/screenshots/retro-setup-groups.png) ·
[sets](docs/screenshots/retro-setup-sets.png) · [warnings](docs/screenshots/retro-setup-warnings.png) ·
[display](docs/screenshots/retro-setup-display.png). Green: [board](docs/screenshots/retro-green-1600.png),
phone: [retro](docs/screenshots/retro-phone.png).

The nodes, names and key in the pictures are invented. `node web/test/smoke/readme-shots.mjs`
makes them again from the code as it is (headless Chrome, the smoke test's fake fleet).

## What changed with lou-20

From firmware lou-20 the control plane is per node and knows no region (the scheme is called
mcc3; mccontrol-spec's wire format has the bytes):

- **Per node, sealed.** A command goes to one node only, on `mcc/cmd/<KEY>` (its whole public
  key), encrypted to that node and signed inside; the answer comes back encrypted to you on a
  reply topic named only inside the command. The command server sees neither the command nor
  who sent it: the page signs in with a throwaway key drawn for each session. There is no IATA,
  no region and no broadcast topic, and every node uses the shared command server.
- **Discovery from alive.** Each lou-20 node keeps a sealed "alive" message on the command
  server (`mcc/alive/<KEY>`, every 15 minutes and at boot) that only its owner's key opens.
  While the key is unlocked the page reads them all and adds the nodes that are yours, wherever
  they are, by their whole key; a node that went offline or was rekeyed away is marked so.
  Nothing is sent, and no area or region is chosen anywhere: Setup's area tab is gone.
- **A county is one command per node.** "Each of your nodes in a county" sends each node that
  names that county as its own region home (from its alive) its own sealed command, in random
  order, 10-90 s apart (5-30 min for a restart). A command that transmits, and the mesh road,
  go to one node only. A node's region home appears only in that node's details.
- **The mesh road is sealed too.** Through your companion a lou-20 node gets a sealed request
  and answers sealed to you; the companion that carries it cannot read either.
- **The old scheme stays for lou-19 and older.** A node whose alive opened, or whose version is
  lou-20 or later, gets mcc3; any other gets the per-node IATA scheme it has always spoken, on
  the IATA code stored for it (the node form asks for it only on such a node). The old
  discovery runs only in the IATA codes of your own old nodes. A lou-19 node takes `ota update`
  over the old scheme, comes back on lou-20, and moves to mcc3 by itself at its first alive.
  lou-21 removes the old scheme; the page drops it after that.

## Install it as an app

Setup, Display has **Install as an app** (Chrome, Edge; Safari and others from their own menu).
The installed app keeps one release offline, checked file by file against that release's
`integrity.json`, and changes to a new release only when you press "Switch now". Each release
is also a zip on the [releases page](https://github.com/sweden-mesh/mccontrol-web/releases)
with its `integrity.json` and SHA-256, for owners who would rather serve the files themselves
from any static host over HTTPS.

## How the four repositories relate

- **mccontrol-web** (this one): the browser app and its Cloudflare Pages deploy.
- [mccontrol-cli](https://github.com/sweden-mesh/mccontrol-cli): the same tool in a terminal
  (Python), and the reference implementation; a key backup file moves between the two.
- [mccontrol-spec](https://github.com/sweden-mesh/mccontrol-spec): the wire format, the command
  table, the deny list, the help texts and the shared test vectors. This app keeps a copy of one
  tag in `web/lib/data/` and `web/test/`, recorded in `spec.lock`; its tests prove it gives
  byte-identical envelopes, results and checks to the CLI.
- [mccontrol](https://github.com/sweden-mesh/mccontrol): a landing page pointing at the three.

The firmware it talks to is [MeshCore-lou](https://github.com/sweden-mesh/MeshCore-lou).

## Run, test, deploy

```
python3 -m http.server -d web 8000 --bind 127.0.0.1    # then open http://127.0.0.1:8000/
node --test "web/test/**/*.test.js"                    # node 22, offline
node web/test/smoke/run.mjs                            # every modal in headless Chrome
node web/test/smoke/filled.mjs                         # the filled board, phone and desktop
node scripts/spec-sync.mjs v0.1.0                      # copy a mccontrol-spec tag; --check compares
node scripts/web-dist.mjs --out dist/web --version v0.1.0 --commit "$(git rev-parse HEAD)"
```

`web-dist.mjs` makes the deployable copy (versions stamped, `integrity.json` with the SHA-256 of
every file); `.github/workflows/web-deploy.yml` tests every push and deploys `main` to the Pages
project `mccontrol` when the repository variable `DEPLOY_ENABLED` is `true`. Conventions, layout
and the design notes are in [web/README.md](web/README.md).

## Licence

MIT, see [LICENSE](LICENSE). Vendored libraries keep their own licences under `web/vendor/`.
