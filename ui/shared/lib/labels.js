/**
 * The words a component says, with English defaults, so that no component has
 * to know which language its app speaks. An app passes `labels` to override
 * any of them. A label is text with `{name}` where a value goes, or a function
 * of those values for wording that varies, such as a plural; one left out
 * falls back to its default.
 */
export function createSay(defaults) {
  return (labels, key, values = {}) => {
    const found = labels?.[key] ?? defaults[key];
    if (typeof found === 'function') return found(values);
    return String(found).replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
  };
}

/** A label made safe to place in markup written as a string, inside an
 * attribute's quotes or between tags. Labels come from whoever uses the
 * component, so a quote in one must not end the attribute it sits in. */
export function escapeMarkup(text) {
  return String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}
