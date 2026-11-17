// The areas an owner picks from (W-20b): counties with their scope, resolved to the IATA codes the
// control plane is addressed by. The table is lib/data/areas.json (exported from mccontrol/areas.py,
// the regional template's counties); nothing here restates it.
//
//   areaList(table, lang)     [{ scb, county, scope, iatas, label }] in the language's alphabetical order
//   areaLabel(area)           "Jönköpings län · se-jkp"
//   areaByScb(table, scb)     the area, or null
//   iatasOf(table, scb)       ['JKG'], or [] for no area

export const areaLabel = (a) => `${a.county} · ${a.scope}`;

export function areaList(table, lang = 'sv') {
  const collator = new Intl.Collator(lang === 'en' ? 'en' : 'sv');
  return (table?.areas || []).map((a) => Object.freeze({ ...a, iatas: [...a.iatas], label: areaLabel(a) }))
    .sort((a, b) => collator.compare(a.county, b.county));
}

export function areaByScb(table, scb) {
  return (table?.areas || []).find((a) => a.scb === scb) || null;
}

export const iatasOf = (table, scb) => [...(areaByScb(table, scb)?.iatas || [])];
