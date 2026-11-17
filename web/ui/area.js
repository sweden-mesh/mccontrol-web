// The area picker (W-20b, operator decision 7): a county dropdown showing the scope
// ("Jönköpings län · se-jkp"); the app resolves it to the IATA code(s) underneath
// (ui/automation.js). Choosing is a submit, not a change of the select, because it starts a
// discovery (a signed broadcast) in the new area. Setup's area tab and anything else can mount it:
//
//   areaPicker(ctx, { id = 'area' })   -> element; ctx needs t, lang and (optional) signal
//
// Without a key it says to make one first: the area belongs to the key (its meta store).
import { h } from './dom.js';
import { areaChoices, automationState, onAutomation, setArea } from './automation.js';

export function areaPicker(ctx, { id = 'area' } = {}) {
  const box = h('div', { class: 'area-picker' });
  const draw = () => {
    const s = automationState();
    if (!s.owner) {
      box.replaceChildren(h('p', { class: 'muted' }, ctx.t('area.needKey'), ' ',
        h('a', { href: '#setup/key' }, ctx.t('area.toKey'))));
      return;
    }
    const current = s.area?.scb || '';
    const select = h('select', { id, name: 'area', 'aria-describedby': `${id}-help`, required: true },
      h('option', { value: '' }, ctx.t('area.placeholder')),
      areaChoices(ctx.lang).map((a) => h('option', { value: a.scb, selected: a.scb === current }, a.label)));
    const status = h('p', { role: 'status', class: 'muted', id: `${id}-status` });
    const form = h('form', { class: 'stack', 'aria-labelledby': `${id}-label` },
      h('div', { class: 'field' },
        h('label', { for: id, id: `${id}-label` }, ctx.t('area.label')),
        select,
        h('p', { id: `${id}-help`, class: 'muted small' }, ctx.t('area.help'))),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'button' }, ctx.t('area.save'))),
      status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await setArea(select.value);
        const chosen = automationState().area;
        status.textContent = chosen ? ctx.t('area.saved', { area: chosen.label }) : ctx.t('area.cleared');
      } catch (err) {
        status.textContent = ctx.t('area.failed', { reason: err.message });
      } finally {
        button.disabled = false;
      }
    });
    box.replaceChildren(form);
  };
  let owner = automationState().owner;
  const off = onAutomation((s) => { if (s.owner !== owner) { owner = s.owner; draw(); } });
  ctx.signal?.addEventListener('abort', off, { once: true });
  draw();
  return box;
}
