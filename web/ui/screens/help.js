// Help (W-8): the texts every mccontrol interface shares (lib/data/help.json, exported from the
// Python package, in English) and every result code a node can answer with (results.json).
//   #/help            the contents, then the result codes
//   #/help/<topic>    one topic; [[name]] in a text links to that topic
import { h } from '../dom.js';
import { useStyles } from './key-kit.js';
import { loadAll } from '../../lib/data/load.js';

export const route = 'help';
export const title = 'nav.help';

// A help body as runs of text and links: [{ text } | { topic }]. Unknown names stay text.
export function helpRuns(body, topics, pattern = '\\[\\[([a-z0-9_-]+)\\]\\]') {
  const re = new RegExp(pattern, 'g');
  const out = [];
  let at = 0;
  for (const m of String(body).matchAll(re)) {
    if (m.index > at) out.push({ text: body.slice(at, m.index) });
    out.push(topics[m[1]] ? { topic: m[1] } : { text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at) });
  return out;
}

// Every result code in order: [{ code, name, help, sv }]: mccontrol-spec's text for every code (W-36:
// the texts the page once carried itself are the spec's now), in English, and its Swedish where
// the spec has one (`help_sv`).
export function resultRows(results) {
  return Object.entries(results.codes).map(([code, name]) => ({ code: Number(code), name, help: results.help[code] || '',
    sv: results.help_sv?.[code] || '' }))
    .sort((a, b) => a.code - b.code);
}

const textBlock = (body, data) => h('pre', { class: 'help-text', lang: 'en', translate: 'no' },
  helpRuns(body, data.help.topics, data.help.link_pattern).map((r) => (r.topic ? h('a', { href: `#/help/${r.topic}` }, r.topic) : r.text)));

function codesTable(ctx, data) {
  const { t } = ctx;
  return h('section', { 'aria-labelledby': 'codes-title' },
    h('h2', { id: 'codes-title' }, t('help.codes')),
    h('p', {}, t('help.codesBody')),
    h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-labelledby': 'codes-title' },
      h('table', { class: 'codes' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('help.code')), h('th', { scope: 'col' }, t('help.name')), h('th', { scope: 'col' }, t('help.meaning')))),
        h('tbody', {}, resultRows(data.results).map((r) => h('tr', { id: `code-${r.code}` },
          h('td', { class: 'num' }, String(r.code)),
          h('th', { scope: 'row' }, h('code', {}, r.name)),
          ctx.lang === 'sv' && r.sv ? h('td', { lang: 'sv' }, r.sv) : h('td', { lang: 'en' }, r.help)))))));
}

export function render(ctx) {
  useStyles();
  const { t } = ctx;
  const name = String(ctx.args[0] || '');
  const heading = h('h1', { id: 'help-title' }, t('nav.help'));
  const body = h('div', {}, h('p', { class: 'muted', role: 'status' }, t('node.loading')));
  const section = h('section', { 'aria-labelledby': 'help-title', class: 'scr key-screen help-screen' }, heading, body);
  loadAll().then((data) => {
    if (ctx.signal.aborted) return;
    const topic = data.help.topics[name];
    if (name && name !== 'codes' && !topic) {
      body.replaceChildren(h('p', {}, t('help.noTopic', { name })), h('p', {}, h('a', { href: '#/help' }, t('help.contents'))));
      return;
    }
    if (name === 'codes') {
      heading.textContent = t('help.codes');
      body.replaceChildren(codesTable(ctx, data), h('p', {}, h('a', { href: '#/help' }, t('help.contents'))));
    } else if (topic) {
      heading.textContent = topic.title;
      heading.lang = 'en';
      body.replaceChildren(h('p', { class: 'muted' }, t('help.english')), textBlock(topic.body, data),
        h('p', {}, h('a', { href: '#/help' }, t('help.contents'))));
    } else {
      const index = data.help.topics.index;
      body.replaceChildren(
        h('p', {}, t('help.intro')),
        h('section', { 'aria-labelledby': 'contents-title', lang: 'en' },
          h('h2', { id: 'contents-title' }, index.title), textBlock(index.body, data)),
        codesTable(ctx, data),
        // What the page is made with, and the credits its licences ask for.
        h('section', { 'aria-labelledby': 'about-title' },
          h('h2', { id: 'about-title' }, t('help.about')),
          h('p', {}, t('help.aboutBody')),
          h('ul', {}, ['help.creditFa', 'help.creditMap', 'help.creditMapLibre', 'help.creditPlex', 'help.creditNe'].map((k) => h('li', {}, t(k))))));
    }
    document.title = `${heading.textContent} · mccontrol`;
  }).catch((ex) => body.replaceChildren(h('p', { class: 'err' }, ex.message)));
  return section;
}
