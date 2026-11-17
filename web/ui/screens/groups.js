// Groups (W-9, RM-4): a name and its member nodes, kept in this browser. A send or a set run to
// a group is one signed per-node command to each member in turn, on its own topic, never a
// broadcast; a member that cannot take the command is reported and the rest still go.
// #/groups lists them; #/groups/<name> is one group: send, run a set, change its members.
import { h } from '../dom.js';
import {
  byName, confirm, field, nameOf, screen, withServices, put,
} from './node-kit.js';
import { sendPanel } from './send.js';
import { runSetPanel } from './sets.js';

export const route = 'groups';
export const title = 'nav.groups';

function memberPicker(ctx, devices, chosen = []) {
  const boxes = devices.map((d) => {
    const box = h('input', { type: 'checkbox', value: d.node, checked: chosen.includes(d.node) });
    return { box, el: h('label', { class: 'pick' }, box, h('span', {}, nameOf(d)), h('span', { class: 'muted small' }, d.region)) };
  });
  return {
    el: h('fieldset', { class: 'targets' }, h('legend', {}, ctx.t('groups.members')), h('div', { class: 'pick-grid' }, boxes.map((b) => b.el))),
    values: () => boxes.filter((b) => b.box.checked).map((b) => b.box.value),
  };
}

function one(ctx, svc, body, name) {
  return async () => {
    const group = await svc.stores.groups.get(name);
    const devices = (await svc.stores.devices.list()).sort(byName(ctx.lang));
    if (!group) {
      put(body, h('p', {}, ctx.t('groups.missing', { group: name }), ' ', h('a', { href: '#/groups' }, ctx.t('groups.toGroups'))));
      return;
    }
    const heading = document.getElementById('groups-title');
    heading.textContent = ctx.t('groups.one', { group: group.id });
    document.title = `${heading.textContent} · mccontrol`;
    const members = devices.filter((d) => group.members.includes(d.node));
    const picker = memberPicker(ctx, devices, group.members);
    const save = h('button', { type: 'submit', class: 'button' }, ctx.t('groups.save'));
    const out = h('p', { 'aria-live': 'polite' });
    const form = h('form', { class: 'stack' }, picker.el, h('div', { class: 'row' }, save), out);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = picker.values();
      await svc.stores.groups.change(group.id, { add: next, remove: group.members.filter((m) => !next.includes(m)) });
      out.textContent = ctx.t('groups.saved');
      one(ctx, svc, body, name)();
    }, { signal: ctx.signal });
    const del = h('button', { type: 'button', class: 'tool tool-danger' }, ctx.t('groups.delete'));
    del.addEventListener('click', async () => {
      if (!await confirm(ctx, { title: ctx.t('groups.deleteTitle', { group: group.id }), lines: [ctx.t('groups.deleteBody')], confirmLabel: ctx.t('groups.delete'), danger: true })) return;
      await svc.stores.groups.remove(group.id);
      ctx.navigate('#/groups');
    }, { signal: ctx.signal });
    const target = { group, devices: members };
    put(body, 
      h('p', {}, h('a', { href: '#/groups' }, ctx.t('groups.toGroups'))),
      h('p', { class: 'node-meta' }, members.length ? members.flatMap((d, i) => [i ? ', ' : '', h('a', { href: `#/node/${d.node}` }, nameOf(d))]) : ctx.t('groups.noMembers')),
      members.length ? [
        h('h2', {}, ctx.t('groups.sendTitle')),
        h('p', { class: 'muted' }, ctx.t('groups.sendExplain', { n: members.length })),
        sendPanel(ctx, svc, target),
        h('h2', {}, ctx.t('sets.title')),
        runSetPanel(ctx, svc, target, await svc.stores.sets.list()),
      ] : null,
      h('h2', {}, ctx.t('groups.change')),
      form,
      h('div', { class: 'row' }, del));
  };
}

function list(ctx, svc, body) {
  const draw = async () => {
    const groups = await svc.stores.groups.list();
    const devices = (await svc.stores.devices.list()).sort(byName(ctx.lang));
    const names = Object.fromEntries(devices.map((d) => [d.node, nameOf(d)]));
    const nameInput = h('input', { type: 'text', autocomplete: 'off', class: 'short' });
    const picker = memberPicker(ctx, devices);
    const out = h('p', { 'aria-live': 'polite' });
    const form = h('form', { class: 'stack' }, field(ctx.t('groups.name'), nameInput, ctx.t('groups.nameHint')), picker.el,
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'button' }, ctx.t('groups.create'))), out);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const g = await svc.stores.groups.create(nameInput.value, picker.values());
        ctx.navigate(`#/groups/${encodeURIComponent(g.id)}`);
      } catch (err) { out.textContent = err.message; nameInput.focus(); }
    }, { signal: ctx.signal });
    put(body, 
      groups.length ? h('ul', { class: 'group-list' }, groups.map((g) => h('li', {},
        h('a', { href: `#/groups/${encodeURIComponent(g.id)}`, class: 'group-name' }, g.id),
        h('span', { class: 'muted' }, ` ${ctx.t('groups.size', { n: g.members.length })}: `),
        h('span', {}, g.members.map((m) => names[m]).join(', '))))) : h('p', {}, ctx.t('groups.none')),
      devices.length ? h('details', { class: 'block', open: !groups.length }, h('summary', {}, ctx.t('groups.new')), form)
        : h('p', { class: 'muted' }, ctx.t('send.noNodes')));
  };
  return draw;
}

export function render(ctx) {
  const body = h('div', {});
  const el = screen('groups', ctx.t('nav.groups'), body);
  withServices(ctx, body, async (svc) => {
    const name = ctx.args[0];
    await (name ? one(ctx, svc, body, name) : list(ctx, svc, body))();
  });
  return el;
}
