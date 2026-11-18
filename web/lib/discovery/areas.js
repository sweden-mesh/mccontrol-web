// The areas an owner picks from (W-20b): counties with their scope, resolved to the IATA codes the
// control plane is addressed by. The table is lib/data/areas.json (exported from mccontrol/areas.py,
// the regional template's counties); nothing here restates it.
//
//   areaList(table, lang)     [{ scb, county, scope, iatas, label }] in the language's alphabetical order
//   areaLabel(area)           "Jönköpings län · se-jkp"
//   areaByScb(table, scb)     the area, or null
//   iatasOf(table, scb)       ['JKG'], or [] for no area
//   areaByScope(table, s)     the county of a node's `region home`, or null
//   nodeAreas(table, devs)    the counties the owner's nodes are in, for an area act
//   areaName(table, scope)    the county's name
import { areaOf } from '../jobs/scheme.js';

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

// The county whose scope is `scope` (a node's `region home`, folded), or null.
export function areaByScope(table, scope) {
  const s = String(scope || '').trim().toLowerCase();
  return (table?.areas || []).find((a) => a.scope === s) || null;
}

// The counties the owner's nodes are in, by each node's own `region home` (its alive; IATA-2):
// [{ scope, label, count }] sorted by county, for an area act's target. A node whose region home
// names no county of the table is in none.
export function nodeAreas(table, devices, lang = 'sv') {
  const counts = new Map();
  for (const d of devices) {
    const a = areaByScope(table, areaOf(d));
    if (a) counts.set(a.scope, { scope: a.scope, label: a.county, count: (counts.get(a.scope)?.count || 0) + 1 });
  }
  const collator = new Intl.Collator(lang === 'en' ? 'en' : 'sv');
  return [...counts.values()].sort((a, b) => collator.compare(a.label, b.label));
}

// What an area act's target is called on screen: its county (from a scope, or from the IATA code
// an old region-wide send recorded), else the text as it is.
export const areaName = (table, scope) => areaByScope(table, scope)?.county
  || (table?.areas || []).find((a) => a.iatas.includes(String(scope || '').toUpperCase()))?.county || String(scope || '');
