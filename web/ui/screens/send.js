// Send (W-8): a command to one node, several, a group, or (an advanced action) every node in a
// region. The field completes from the command table; the deny list, the broadcast rules and
// the node's firmware are checked as you type, before anything is signed; a command that takes
// something away asks first; a region-wide send always asks, naming the region and how many
// nodes are expected to answer. Each result is said in words with the code's help text.
//
// sendPanel(ctx, svc, target) is the same form inside the node and group screens.
import { h } from '../dom.js';
import { preflight } from '../../lib/jobs/checks.js';
import {
  byName, confirm, explain, field, nameOf, outcomeTag, progressLine, screen, withServices, put, resultBody, unlockHere,
} from './node-kit.js';

export const route = 'send';
export const title = 'send.title';

let listCount = 0;

// The datalist of the command table: each command, its choices and its examples.
function commandList(svc) {
  const id = `cmds-${listCount += 1}`;
  const seen = new Set();
  const options = [];
  const add = (text) => { if (text && !seen.has(text) && !text.includes('<')) { seen.add(text); options.push(h('option', { value: text })); } };
  for (const c of svc.data.commands.table) {
    if (c.text === 'get' || c.text === 'set') { c.examples.forEach((e) => add(e.split(':')[0].trim())); continue; }
    if (c.kind === 'none') add(c.text);
    for (const choice of c.choices) add(`${c.text} ${choice}`.trim());
    for (const ex of c.examples) add(`${c.text} ${ex}`);
  }
  return { id, el: h('datalist', { id }, options) };
}

export function whyText(ctx, block) {
  return ctx.t(`send.why.${block.code}`, block.vars);
}

// target: { devices: [device] } | { group: { id, members }, devices } | { region, devices }
export function sendPanel(ctx, svc, target, { onDone = null, initial = '' } = {}) {
  const list = commandList(svc);
  const input = h('input', {
    type: 'text', list: list.id, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    class: 'cmd-input', enterkeyhint: 'send', value: initial,
  });
  const check = h('div', { class: 'checks', 'aria-live': 'polite' });
  const sendButton = h('button', { type: 'submit', class: 'button' }, ctx.t('send.button'));
  const stop = h('button', { type: 'button', class: 'tool', hidden: true }, ctx.t('send.stop'));
  const results = h('div', { class: 'results' });
  const one = !target.region && target.devices.length === 1 ? target.devices[0] : null;
  const form = h('form', { class: 'send-form', novalidate: true },
    field(ctx.t('send.command'), input, ctx.t('send.commandHint')),
    list.el, check, h('div', { class: 'row' }, sendButton, stop), results);

  const verdict = () => preflight(svc.rules, { command: input.value, device: one, region: target.region || null });

  function drawChecks() {
    const p = verdict();
    const lines = [];
    if (p.block && p.command) lines.push(h('p', { class: 'check check-block' }, h('strong', {}, ctx.t('send.blocked')), ' ', whyText(ctx, p.block)));
    if (!p.block && p.caution) lines.push(h('p', { class: 'check check-caution' }, h('strong', {}, ctx.t('send.caution')), ' ', p.caution));
    if (!p.block && one && p.admits === false) {
      lines.push(h('p', { class: 'check check-caution' }, p.lacks
        ? ctx.t('send.lacks', { feature: p.lacks, version: one.ver })
        : ctx.t('send.notAdmitted', { version: one.ver, needs: p.needs || '?' })));
    }
    if (!p.block && !target.region && p.command) {
      const many = target.devices.filter((d) => d.ver && !svc.rules.admits(d.ver, p.command));
      if (!one && many.length) lines.push(h('p', { class: 'check check-caution' }, ctx.t('send.someRefuse', { n: many.length, names: many.map(nameOf).join(', ') })));
      lines.push(h('p', { class: 'check muted' }, one
        ? (p.v2 ? ctx.t('send.v2') : ctx.t('send.v1'))
        : ctx.t('send.perNode', { n: target.devices.length })));
    }
    if (!p.block && target.region && p.command) lines.push(h('p', { class: 'check muted' }, ctx.t('send.broadcastNote', { region: target.region, n: target.devices.length })));
    put(check, ...lines);
  }
  input.addEventListener('input', drawChecks, { signal: ctx.signal });
  drawChecks();

  let running = null;
  stop.addEventListener('click', () => running?.abort(), { signal: ctx.signal });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const p = verdict();
    if (!p.command) { input.focus(); return; }
    if (p.block) { drawChecks(); input.focus(); return; }
    const who = target.region ? ctx.t('send.whoRegion', { region: target.region, n: target.devices.length })
      : target.group ? ctx.t('send.whoGroup', { group: target.group.id, n: target.devices.length })
        : target.devices.map(nameOf).join(', ');
    if (target.region || p.caution) {
      const ok = await confirm(ctx, {
        title: target.region ? ctx.t('send.confirmRegionTitle', { region: target.region }) : ctx.t('send.confirmTitle'),
        lines: [
          h('p', {}, h('code', {}, p.command), ' → ', who),
          p.caution ? h('p', {}, p.caution) : null,
          target.region ? h('p', {}, ctx.t('send.confirmRegionBody', { region: target.region, n: target.devices.length })) : null,
        ].filter(Boolean),
        confirmLabel: target.region ? ctx.t('send.confirmRegionButton', { n: target.devices.length }) : ctx.t('send.confirmButton'),
        danger: true,
      });
      if (!ok) return;
    }
    running = new AbortController();
    sendButton.disabled = true;
    stop.hidden = false;
    const bar = progressLine();
    put(results, bar.el);
    bar.set(null, ctx.t('send.signing'));
    try {
      const out = await svc.jobs.send({
        command: p.command,
        nodes: target.region || target.group ? null : target.devices.map((d) => d.node),
        group: target.group?.id || null,
        region: target.region || null,
        signal: running.signal,
        onProgress: (s) => bar.set(s.total ? s.elapsed / s.total : null, s.region
          ? ctx.t('send.waitRegion', { n: s.answered, of: s.count, secs: Math.ceil(s.total - s.elapsed) })
          : ctx.t('send.waitNode', { name: s.name, i: s.index + 1, of: s.count })),
      });
      put(results, resultList(ctx, svc, out, target));
      ctx.announce(ctx.t('send.doneSummary', { answered: out.answered, asked: out.asked }));
      onDone?.(out);
    } catch (err) {
      const text = err.code === 'locked' ? ctx.t('send.locked') : err.code ? ctx.t(`send.why.${err.code}`, err.vars) : err.message;
      put(results, h('p', { class: 'err', role: 'alert' }, text,
        err.code === 'locked' ? [' ', h('a', { href: unlockHere(ctx) }, ctx.t('send.unlockLink'))] : null));
    } finally {
      running = null;
      sendButton.disabled = false;
      stop.hidden = true;
    }
  }, { signal: ctx.signal });

  return form;
}

// The outcome of a send: a summary line, then one row per node.
export function resultList(ctx, svc, out, target) {
  const devices = new Map(target.devices.map((d) => [d.node, d]));
  const rows = out.outcomes.map((o) => {
    if (!o.sent) {
      return h('li', { class: 'res res-unsent' },
        h('span', { class: 'res-name' }, h('a', { href: `#/node/${o.node}` }, o.name)),
        h('span', { class: 'tag tag-unsent' }, ctx.t('send.notSent')),
        h('span', { class: 'res-text' }, o.reason ? ctx.t(`send.why.${o.reason.code}`, o.reason.vars) : ''));
    }
    const x = explain(ctx, svc, o.result, devices.get(o.node));
    return h('li', { class: `res res-${x.kind}` },
      h('span', { class: 'res-name' }, h('a', { href: `#/node/${o.node}` }, o.name)),
      outcomeTag(ctx, x.kind),
      h('span', { class: 'res-text' }, resultBody(x)[0]),
      resultBody(x)[1] ? h('span', { class: 'res-help' }, resultBody(x)[1]) : null);
  });
  return h('div', {},
    h('p', { class: 'res-summary' }, ctx.t('send.summary', { command: out.command, answered: out.answered, asked: out.asked })),
    h('ul', { class: 'res-list' }, rows),
    h('p', { class: 'muted small' }, ctx.t('send.silenceNote'), ' ', h('a', { href: '#/history' }, ctx.t('send.toHistory'))));
}

export function render(ctx) {
  const body = h('div', {});
  const el = screen('send', ctx.t('send.title'), h('p', { class: 'lede' }, ctx.t('send.lede')), body);
  withServices(ctx, body, async (svc) => {
    const devices = (await svc.stores.devices.list()).sort(byName(ctx.lang));
    const groups = await svc.stores.groups.list();
    if (!devices.length) {
      put(body, h('p', {}, ctx.t('send.noNodes'), ' ', h('a', { href: '#/nodes' }, ctx.t('send.toNodes'))));
      return;
    }
    const pre = new Set(ctx.args.map((a) => a.toUpperCase()));
    const panelSlot = h('div', {});
    const picks = devices.map((d) => {
      const box = h('input', { type: 'checkbox', value: d.node, checked: pre.has(d.node) });
      return { d, box, el: h('label', { class: 'pick' }, box, h('span', {}, nameOf(d)), h('span', { class: 'muted small' }, d.region)) };
    });
    const groupSelect = h('select', {}, h('option', { value: '' }, ctx.t('send.pickGroup')),
      groups.filter((g) => g.members.length).map((g) => h('option', { value: g.id }, `${g.id} (${g.members.length})`)));
    const regions = [...new Set(devices.map((d) => d.region))].sort();
    const regionSelect = h('select', {}, h('option', { value: '' }, ctx.t('send.pickRegion')),
      regions.map((r) => h('option', { value: r }, ctx.t('send.regionOption', { region: r, n: devices.filter((d) => d.region === r).length }))));
    const mode = (name, checked) => h('input', { type: 'radio', name: 'send-target', value: name, checked });
    const modes = { nodes: mode('nodes', true), group: mode('group', false), region: mode('region', false) };
    const advanced = h('details', { class: 'advanced' },
      h('summary', {}, ctx.t('send.advanced')),
      h('p', { class: 'muted' }, ctx.t('send.regionExplain')),
      h('label', { class: 'pick' }, modes.region, h('span', {}, ctx.t('send.toRegion'))),
      field(ctx.t('send.region'), regionSelect));

    let current = '';
    const draw = () => {
      const keep = panelSlot.querySelector('.cmd-input')?.value || current;
      current = keep;
      let target = null;
      if (modes.nodes.checked) {
        const chosen = picks.filter((p) => p.box.checked).map((p) => p.d);
        if (chosen.length) target = { devices: chosen };
      } else if (modes.group.checked && groupSelect.value) {
        const g = groups.find((x) => x.id === groupSelect.value);
        target = { group: g, devices: devices.filter((d) => g.members.includes(d.node)) };
      } else if (modes.region.checked && regionSelect.value) {
        target = { region: regionSelect.value, devices: devices.filter((d) => d.region === regionSelect.value) };
      }
      put(panelSlot, target ? sendPanel(ctx, svc, target, { initial: keep })
        : h('p', { class: 'muted' }, ctx.t('send.pickTarget')));
    };
    for (const p of picks) p.box.addEventListener('change', () => { modes.nodes.checked = true; draw(); }, { signal: ctx.signal });
    groupSelect.addEventListener('change', () => { modes.group.checked = true; draw(); }, { signal: ctx.signal });
    regionSelect.addEventListener('change', () => { modes.region.checked = true; draw(); }, { signal: ctx.signal });
    for (const m of Object.values(modes)) m.addEventListener('change', draw, { signal: ctx.signal });

    put(body, 
      h('fieldset', { class: 'targets' },
        h('legend', {}, ctx.t('send.to')),
        h('label', { class: 'pick' }, modes.nodes, h('span', {}, ctx.t('send.toNodes'))),
        h('div', { class: 'pick-grid' }, picks.map((p) => p.el)),
        h('label', { class: 'pick' }, modes.group, h('span', {}, ctx.t('send.toGroup'))),
        field(ctx.t('send.group'), groupSelect),
        advanced),
      panelSlot);
    draw();
  });
  return el;
}
