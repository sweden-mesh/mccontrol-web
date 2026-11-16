// Build DOM without HTML strings: the page runs under Trusted Types, so innerHTML and its
// relatives are blocked. h('p', {class: 'x'}, 'text', child) makes an element; text is
// always set as text.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name.startsWith('on')) throw new Error('attach listeners with addEventListener');
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
