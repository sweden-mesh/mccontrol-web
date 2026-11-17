// What a command does, in a few words, for the palette's rows and a command set's steps (W-20i).
// The commands come from the exported table (lib/data/commands.json); the words are strings,
// "palette.cmd.<command>", one per table entry in each language (test/setup-palette.test.js
// fails when the table gains a command without them). No DOM.

// The table entry a typed line is an instance of: the longest command it starts with, so
// "region put se-jkp *" is "region put" and "get mqtt1.server" falls back to "get".
export function commandOf(table, line) {
  const text = String(line || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!text) return null;
  let best = null;
  for (const c of table) {
    const k = c.text.toLowerCase();
    if ((text === k || text.startsWith(`${k} `)) && (!best || k.length > best.text.length)) best = c;
  }
  return best;
}

export const helpKey = (command) => `palette.cmd.${command.text}`;

// The words for a line, or '' when the table does not know it.
export function commandHelp(t, table, line) {
  const c = commandOf(table, line);
  return c ? t(helpKey(c)) : '';
}
