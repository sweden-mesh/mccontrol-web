// The checks a screen makes before signing, ported from the Python package and driven by the
// JSON it exports (lib/data/): the deny list (denylist.py), cautions (actions.caution), what
// each firmware version admits (firmware.py), reads and command building (commands.py), and
// the facts in an answer (facts.parse). test/vectors.json's `checks` pin every function to
// Python's answers.
//
//   const rules = rulesFrom(await loadAll());   // or just the five files it reads
//   rules.refusal('set prv.key 00')             // 'denied: identity: ...'
import { squash, words } from './text.js';

// prefix at the start of text, then the end, a space or a dot. Case-insensitive.
function boundary(text, prefix) {
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  return text.length === prefix.length || text[prefix.length] === ' ' || text[prefix.length] === '.';
}

export function rulesFrom({ denylist, cautions, commands, firmware, facts }) {
  const msg = denylist.messages;

  function slotCredentialRead(text) {
    const low = text.toLowerCase();
    if (!low.startsWith('get mqtt') || low.length < 10 || !/[0-9]/.test(low[8])) return false;
    const rest = low.slice(9);
    return denylist.slot_credential_leaves.some((leaf) => rest.startsWith(leaf)
      && (rest.length === leaf.length || rest[leaf.length] === ' ' || rest[leaf.length] === '.'));
  }

  // Why the firmware will refuse `command`, or null when it travels.
  function refusal(command) {
    const text = squash(command);
    if (!text) return msg.empty;
    if (text.includes('|')) return msg.separator;
    const low = text.toLowerCase();
    for (const { prefix, why } of denylist.families) {
      if (boundary(text, prefix)) return msg.family.replace('{why}', why);
    }
    if (denylist.prefixes.some((p) => low.startsWith(p))) return msg.secret;
    if (slotCredentialRead(text)) return msg.slot_credential;
    if (low === 'set' || low === 'get') return msg.no_setting;
    for (const { text: verb, exact } of denylist.verbs) {
      if (exact ? low === verb : boundary(text, verb)) return null;
    }
    return msg.not_admitted;
  }

  // Why a command that may go to one node may not go to every node in a region, beyond a
  // transmit (isTransmit in envelope.js), or null.
  const broadcastRefusal = (command) => (denylist.broadcast_refused.includes(squash(command).toLowerCase())
    ? denylist.broadcast_refused_why : null);

  // A sentence saying what a command takes away, or null for a harmless one.
  function caution(command) {
    const text = squash(command.toLowerCase());
    for (const { prefix, why } of cautions.cautions) {
      if (prefix.endsWith('*') && !prefix.endsWith(' *')) {
        if (text.startsWith(prefix.slice(0, -1))) return why;
      } else if (text === prefix || text.startsWith(`${prefix} `)) {
        return why;
      }
    }
    return null;
  }

  // Is this a command whose reply is worth keeping? Any `get`, and the listed reads.
  function isRead(text) {
    const head = squash(text).toLowerCase();
    if (head.startsWith('get ')) return true;
    return commands.table.some((c) => c.read && c.text === head);
  }

  // The command text with the chosen values appended (empty values skipped).
  const build = (entry, values) => `${entry.text} ${values.filter(Boolean).join(' ')}`.trim();

  // -- firmware --------------------------------------------------------------------------------

  function revision(versionText) {
    const text = (versionText || '').toLowerCase();
    for (const tag of firmware.revision_tags) {
      const at = text.indexOf(tag);
      if (at < 0) continue;
      const m = /^\d+/.exec(text.slice(at + tag.length));
      return m ? Number(m[0]) : null;
    }
    return null;
  }

  const louFeatures = new RegExp(firmware.lou_features_pattern);

  function features(versionText) {
    const text = (versionText || '').toLowerCase();
    const m = louFeatures.exec(text);
    if (!m) return text.includes('-lou-') ? '' : firmware.features_before_lou;
    return firmware.feature_tokens.includes(m[1]) ? m[1] : '';
  }

  function has(versionText, code) {
    const token = features(versionText);
    for (let i = 0; i < token.length; i += 2) if (token.slice(i, i + 2) === code) return true;
    return false;
  }

  // The table row a version falls under; an unknown version is the oldest row.
  function entryFor(versionText) {
    const rev = revision(versionText);
    let row = firmware.admitted[0];
    if (rev === null) return row;
    for (const candidate of firmware.admitted) if (rev >= candidate.number) row = candidate;
    return row;
  }

  function rowAdmits(row, command) {
    const text = squash(command);
    if (row.admitted === null) {
      return refusal(text) === null && row.number >= (firmware.arrived[text.toLowerCase()] ?? 0);
    }
    const low = text.toLowerCase();
    return row.admitted.some((entry) => (firmware.ar10_families.includes(entry)
      ? boundary(text, entry) : low === entry));
  }

  const autoreplyCommand = (command) => {
    const text = squash(command);
    return firmware.autoreply_families.some((f) => boundary(text, f));
  };

  function admits(versionText, command) {
    if (!has(versionText, 'rc')) return false;
    if (!has(versionText, 'ar') && autoreplyCommand(command)) return false;
    return rowAdmits(entryFor(versionText), command);
  }

  // The feature ("ar", "rc") a node's image lacks that `command` belongs to, or null.
  function lacks(versionText, command) {
    if (!has(versionText, 'rc')) return 'rc';
    if (!has(versionText, 'ar') && autoreplyCommand(command)) return 'ar';
    return null;
  }

  // The oldest tag that admits `command`, or null.
  const needs = (command) => firmware.admitted.find((row) => rowAdmits(row, command))?.tag ?? null;

  const from = (n) => (versionText) => {
    const rev = revision(versionText);
    return rev !== null && rev >= n;
  };
  const speaksV2 = from(firmware.v2_from);
  const admitsUtf8 = from(firmware.utf8_from);
  // -- the mesh road (denylist.mesh_refusal, firmware.speaks_mesh / mesh_only) ------------------

  const mesh = denylist.mesh;

  // Is `command` on the mesh road's repair allowance (with an uplink)? Case-sensitive, as the
  // node's CLI matches, and only with a value after a with-value prefix.
  const meshAllowed = (command) => {
    const text = command || '';
    return mesh.allowance_with_value.some((p) => text.length > p.length && text.startsWith(p))
      || mesh.allowance_exact.includes(text);
  };

  const needsUplink = (command) => mesh.needs_uplink.includes(squash(command).toLowerCase());

  // Why the firmware will refuse `command` over the mesh road, or null when it travels.
  function meshRefusal(command, meshOnly = false) {
    if (meshOnly) {
      if (needsUplink(command) || meshAllowed(squash(command))) return mesh.mesh_only_why;
      return refusal(command);
    }
    if (meshAllowed(squash(command))) return null;
    return refusal(command);
  }

  // true from lou-19 with the plane (rc), false when the version says otherwise, null unknown.
  function speaksMesh(versionText) {
    const rev = revision(versionText);
    if (rev === null) return null;
    return rev >= firmware.mesh_from && has(versionText, 'rc');
  }

  // The plane without the Observer bridge: no Wi-Fi, no MQTT.
  function meshOnly(versionText) {
    const text = (versionText || '').toLowerCase();
    return text.includes('-lou-') && has(versionText, 'rc') && !text.includes('-observer');
  }

  // A device's own meshOnly flag when set, else what its version says.
  const deviceMeshOnly = (device) => (device?.meshOnly === true || device?.meshOnly === false
    ? device.meshOnly : meshOnly(device?.ver));

  const privateSubtype = (versionText) => (from(firmware.private_subtype.from)(versionText)
    ? firmware.private_subtype.new : firmware.private_subtype.old);

  // -- facts -----------------------------------------------------------------------------------

  const autoreply = new RegExp(facts.autoreply_pattern);

  function valueOf(reply) {
    const text = (reply || '').trim();
    return text.startsWith('>') ? text.slice(1).trim() : null;
  }

  // {fact key: value} carried by `reply` to `command`, or null when the command is not known.
  function parseFacts(command, reply) {
    const w = words(command);
    if (!w.length) return null;
    const verb = w[0].toLowerCase();
    if (verb === 'set' && w.length >= 3) {
      return (reply || '').trim().toUpperCase().startsWith('OK') ? { [w[1].toLowerCase()]: w.slice(2).join(' ') } : {};
    }
    const value = valueOf(reply);
    if (value === null) return null;
    if (w.length === 1 && w[0] === 'ver') return { version: value };
    if (w.length === 1 && w[0] === 'region') return { regions: value };
    if (verb === 'get' && w.length === 2) {
      const key = w[1].toLowerCase();
      if (key === 'autoreply') {
        const m = autoreply.exec(value);
        if (!m) return { autoreply: value.split(',')[0].trim() };
        const [, on, channel, hops, direct, mode, priv] = m;
        return {
          autoreply: on, 'autoreply.channel': channel, 'autoreply.hops': hops,
          'autoreply.direct.flood': direct === 'flood' ? 'on' : 'off', 'autoreply.mode': mode,
          'autoreply.private': priv,
        };
      }
      if (key === 'stats') return null;
      return { [key]: value };
    }
    return null;
  }

  // The command that reads `key` again.
  const reader = (key) => facts.readers[key] ?? facts.readers['*'].replace('{key}', key);

  return Object.freeze({
    refusal, broadcastRefusal, caution, isRead, build,
    revision, features, has, entryFor, admits, lacks, needs, speaksV2, admitsUtf8, privateSubtype,
    meshAllowed, needsUplink, meshRefusal, speaksMesh, meshOnly, deviceMeshOnly,
    parseFacts, reader,
  });
}
