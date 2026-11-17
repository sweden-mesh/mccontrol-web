// Command sets (W-15): a named list of up to six commands sent in order to a node, a group or
// (advanced) a region, stopping at the first refusal or silence. `{arg}` in a step is asked for
// when the set runs. The shipped example stays until it is removed or replaced. Every step is
// checked against the deny list when it is saved and again before the run is signed.
//
// runSetPanel(ctx, svc, target) is the same run form inside the node and group screens.
import { h } from '../dom.js';
import { SET_STEPS } from '../../lib/store/index.js';
import { blocker, fillSteps } from '../../lib/jobs/checks.js';
import {
  byName, confirm, explain, field, nameOf, progressLine, screen, withServices, put, lockedNote } from './node-kit.js';
import { whyText } from './send.js';

export const route = 'sets';
export const title = 'sets.title';

export function runSetPanel(ctx, svc, target, sets) {
  const names = Object.keys(sets);
  if (!names.length) return h('p', { class: 'muted' }, ctx.t('sets.none'), ' ', h('a', { href: '#/sets' }, ctx.t('sets.toSets')));
  const select = h('select', {}, names.map((n) => h('option', { value: n }, n)));
  const arg = h('input', { type: 'text', autocomplete: 'off', class: 'short' });
  const argField = field(ctx.t('sets.arg'), arg, ctx.t('sets.argHint'));
  const steps = h('ol', { class: 'steps' });
  const run = h('button', { type: 'submit', class: 'button' }, ctx.t('sets.run'));
  const out = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'stack' }, field(ctx.t('sets.set'), select), steps, argField, h('div', { class: 'row' }, run), out);
  const draw = () => {
    const s = sets[select.value] || [];
    put(steps, ...s.map((c) => h('li', {}, h('code', {}, c))));
    argField.hidden = !s.some((c) => c.includes('{arg}'));
  };
  select.addEventListener('change', draw, { signal: ctx.signal });
  draw();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let filled;
    try { filled = fillSteps(sets[select.value], arg.value); } catch (err) { put(out, h('p', { class: 'err' }, ctx.t(`send.why.${err.code}`))); arg.focus(); return; }
    const one = !target.region && target.devices.length === 1 ? target.devices[0] : null;
    for (const c of filled) {
      const block = blocker(svc.rules, { command: c, device: one, region: target.region || null });
      if (block) { put(out, h('p', { class: 'err', role: 'alert' }, whyText(ctx, block))); return; }
    }
    const cautions = filled.map((c) => [c, svc.rules.caution(c)]).filter(([, why]) => why);
    if (cautions.length || target.region) {
      const ok = await confirm(ctx, {
        title: target.region ? ctx.t('send.confirmRegionTitle', { region: target.region }) : ctx.t('sets.confirmTitle', { set: select.value }),
        lines: [
          ...cautions.map(([c, why]) => h('p', {}, h('code', {}, c), ' ', why)),
          target.region ? h('p', {}, ctx.t('send.confirmRegionBody', { region: target.region, n: target.devices.length })) : null,
        ].filter(Boolean),
        confirmLabel: ctx.t('sets.confirmButton', { n: filled.length }),
        danger: true,
      });
      if (!ok) return;
    }
    run.disabled = true;
    const bar = progressLine();
    put(out, bar.el);
    try {
      const res = await svc.jobs.runSet({
        steps: sets[select.value], arg: arg.value,
        nodes: target.region || target.group ? null : target.devices.map((d) => d.node),
        group: target.group?.id || null, region: target.region || null, signal: ctx.signal,
        onStep: (s) => bar.set(s.step / s.steps, ctx.t('sets.stepOf', { name: s.name, i: s.step + 1, of: s.steps, command: s.command })),
      });
      put(out, h('ul', { class: 'res-list' }, res.runs.map((r) => runLine(ctx, svc, r, res.steps))));
      ctx.announce(ctx.t('sets.done'));
    } catch (err) {
      put(out, h('p', { class: 'err', role: 'alert' }, err.code === 'locked' ? lockedNote(ctx) : err.code ? ctx.t(`send.why.${err.code}`, err.vars) : err.message));
    } finally { run.disabled = false; }
  }, { signal: ctx.signal });
  return form;
}

function runLine(ctx, svc, run, steps) {
  const done = run.stoppedAt === null;
  const last = run.outcomes.at(-1);
  if (run.region) {
    return h('li', { class: `res ${done ? 'res-ok' : 'res-refused'}` },
      h('span', { class: 'res-name' }, run.name),
      h('span', { class: `tag ${done ? 'tag-ok' : 'tag-refused'}` }, done ? ctx.t('sets.allOk', { n: steps.length }) : ctx.t('sets.stopped', { i: run.stoppedAt + 1 })),
      h('span', { class: 'res-text' }, last ? ctx.t('send.summary', { command: steps[done ? steps.length - 1 : run.stoppedAt], answered: last.answered, asked: last.asked }) : ''));
  }
  const lastResult = last && 'result' in last ? last.result : null;
  const x = run.reason ? null : explain(ctx, svc, done ? lastResult : (last?.result ?? null));
  return h('li', { class: `res ${done ? 'res-ok' : 'res-refused'}` },
    h('span', { class: 'res-name' }, run.node ? h('a', { href: `#/node/${run.node}` }, run.name) : run.name),
    h('span', { class: `tag ${done ? 'tag-ok' : 'tag-refused'}` }, done ? ctx.t('sets.allOk', { n: steps.length }) : ctx.t('sets.stopped', { i: run.stoppedAt + 1 })),
    h('span', { class: 'res-text' }, run.reason ? ctx.t(`send.why.${run.reason.code}`, run.reason.vars)
      : done ? h('code', { class: 'reply' }, x.text) : [h('code', {}, steps[run.stoppedAt]), ' ', x.text]),
    !done && x?.help ? h('span', { class: 'res-help' }, x.help) : null,
    !done ? h('span', { class: 'res-help' }, ctx.t('sets.notSentAfter', { n: steps.length - run.stoppedAt - 1 })) : null);
}

function editor(ctx, svc, name, steps, redraw) {
  const nameInput = h('input', { type: 'text', autocomplete: 'off', value: name, class: 'short' });
  const text = h('textarea', { rows: String(SET_STEPS), spellcheck: 'false', class: 'mono' });
  text.value = steps.join('\n');
  const out = h('p', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'button' }, ctx.t('sets.save'));
  const form = h('form', { class: 'stack' },
    field(ctx.t('sets.name'), nameInput, ctx.t('sets.nameHint')),
    field(ctx.t('sets.steps'), text, ctx.t('sets.stepsHint', { n: SET_STEPS })),
    h('div', { class: 'row' }, save), out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const lines = text.value.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      const why = svc.rules.refusal(l.replaceAll('{arg}', 'x'));
      if (why) { out.textContent = ctx.t('sets.stepDenied', { command: l, why }); text.focus(); return; }
    }
    try {
      await svc.stores.sets.save(nameInput.value, lines);
      out.textContent = ctx.t('sets.saved');
      redraw();
    } catch (err) { out.textContent = err.message; }
  }, { signal: ctx.signal });
  return form;
}

export function render(ctx) {
  const body = h('div', {});
  const el = screen('sets', ctx.t('sets.title'), h('p', { class: 'lede' }, ctx.t('sets.lede')), body);
  withServices(ctx, body, async (svc) => {
    async function draw() {
      const sets = await svc.stores.sets.list();
      const devices = (await svc.stores.devices.list()).sort(byName(ctx.lang));
      const groups = (await svc.stores.groups.list()).filter((g) => g.members.length);
      const list = Object.entries(sets).map(([name, steps]) => {
        const remove = h('button', { type: 'button', class: 'link-button' }, ctx.t('sets.remove'));
        remove.addEventListener('click', async () => {
          if (!await confirm(ctx, { title: ctx.t('sets.removeTitle', { set: name }), confirmLabel: ctx.t('sets.remove') })) return;
          await svc.stores.sets.remove(name);
          draw();
        });
        return h('article', { class: 'set' },
          h('h2', {}, name),
          h('ol', { class: 'steps' }, steps.map((s) => h('li', {}, h('code', {}, s)))),
          h('details', {}, h('summary', {}, ctx.t('sets.edit')), editor(ctx, svc, name, steps, draw)),
          remove);
      });
      const target = h('select', {},
        h('option', { value: '' }, ctx.t('sets.pickTarget')),
        h('optgroup', { label: ctx.t('nav.nodes') }, devices.map((d) => h('option', { value: `n:${d.node}` }, nameOf(d)))),
        groups.length ? h('optgroup', { label: ctx.t('nav.groups') }, groups.map((g) => h('option', { value: `g:${g.id}` }, `${g.id} (${g.members.length})`))) : null);
      const runSlot = h('div', {});
      target.addEventListener('change', () => {
        const [kind, id] = target.value.split(':');
        if (!kind) { put(runSlot, ); return; }
        const t = kind === 'n' ? { devices: devices.filter((d) => d.node === id) }
          : { group: groups.find((g) => g.id === id), devices: devices.filter((d) => groups.find((g) => g.id === id).members.includes(d.node)) };
        put(runSlot, runSetPanel(ctx, svc, t, sets));
      }, { signal: ctx.signal });
      put(body, 
        h('h2', {}, ctx.t('sets.runTitle')),
        devices.length ? [field(ctx.t('sets.target'), target), runSlot] : h('p', { class: 'muted' }, ctx.t('send.noNodes')),
        h('h2', {}, ctx.t('sets.yours')),
        list.length ? h('div', { class: 'set-list' }, list) : h('p', {}, ctx.t('sets.none')),
        h('details', { class: 'block' }, h('summary', {}, ctx.t('sets.new')), editor(ctx, svc, '', [], draw)));
    }
    await draw();
  });
  return el;
}

