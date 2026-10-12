// The searchable entity list inside the detail editor: pick the people on an
// item, or the single owner it belongs to. This app picks actors and studios;
// the archival client picks contributors and channels.
//
// One component covers both because they differ only in arity. Multi-select
// renders checkboxes and can group the selected and recently used entries
// above the rest; single-select renders radios and offers an explicit "none".
// Pending names the viewer typed but has not saved yet sort to the top.
//
// The inputs keep the data-* attributes the delegated listeners read, so the
// save handlers in the app are untouched.
import {html} from '../lib/html.js';

const Option = ({
  entity, multiple, name, checked, custom = false, idAttribute, newAttribute,
}) => html`
  <label class=${custom ? 'is-custom' : undefined}>
    <input type=${multiple ? 'checkbox' : 'radio'}
           name=${multiple ? undefined : name}
           value=${custom ? undefined : String(entity.id ?? '')}
           checked=${checked}
           ...${custom ? {[newAttribute]: entity.name} : (idAttribute && entity.id != null
             ? {[idAttribute]: String(entity.id)} : {})} />
    ${custom ? `${entity.name} (new)` : entity.name}
  </label>`;

/**
 * `entities` is already narrowed by the caller — server-filtered while a query
 * is running, or the full local list when the field is empty — so this only
 * decides ordering and grouping.
 */
export function EntityPicker({
  entities,
  multiple = false,
  // Multi-select: the ids currently ticked, and unsaved names awaiting save.
  selected = new Set(),
  pending = new Set(),
  // Single-select: the chosen id, or a pending name that outranks it.
  chosenId = null,
  pendingName = '',
  // Names used recently, floated to the top while no query is active.
  recent = [],
  query = '',
  limit = 80,
  labels = {},
  // Attribute names the app's listeners read off each input.
  idAttribute = null,
  newAttribute = 'data-new-entity',
  radioName = 'entity-choice',
}) {
  const needle = query.trim().toLowerCase();

  if (!multiple) {
    const noneChecked = !chosenId && !pendingName;
    return html`
      ${pendingName && html`
        <${Option} entity=${{name: pendingName}} multiple=${false} name=${radioName}
                   checked=${true} custom=${true} newAttribute=${newAttribute} />`}
      <label>
        <input type="radio" name=${radioName} value="" checked=${noneChecked} />
        ${labels.none || 'None'}
      </label>
      ${entities.map(entity => html`
        <${Option} key=${entity.id} entity=${entity} multiple=${false} name=${radioName}
                   checked=${chosenId === String(entity.id)} idAttribute=${idAttribute} />`)}
      ${!pendingName && needle && !entities.length && html`
        <p class="entity-options-empty">${labels.createHint || 'Press Enter to create this entry'}</p>`}`;
  }

  // Selected and recently used entries come first, so the names a viewer is
  // most likely to want are not buried in an alphabetical list of hundreds.
  const priorityIds = new Set();
  const recentEntities = needle ? [] : recent
    .map(name => entities.find(entity => entity.name.toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
  const selectedEntities = entities.filter(entity =>
    selected.has(String(entity.id)) && !recentEntities.includes(entity));
  for (const entity of [...selectedEntities, ...recentEntities]) priorityIds.add(String(entity.id));
  const priority = [...selectedEntities, ...recentEntities];
  const remaining = entities.filter(entity => !priorityIds.has(String(entity.id)));
  const visible = remaining.slice(0, limit);
  const pendingNames = [...pending].filter(name => !needle || name.toLowerCase().includes(needle));

  const option = (entity, custom = false) => html`
    <${Option} key=${custom ? `new:${entity.name}` : entity.id} entity=${entity}
               multiple=${true} custom=${custom}
               checked=${custom || selected.has(String(entity.id))}
               idAttribute=${idAttribute} newAttribute=${newAttribute} />`;

  return html`
    ${pendingNames.map(name => option({name}, true))}
    ${priority.length > 0 && html`
      <p class="entity-options-heading">
        ${selectedEntities.length ? (labels.selectedAndRecent || 'Selected & recent')
          : (labels.recent || 'Recently used')}
      </p>`}
    ${priority.map(entity => option(entity))}
    ${priority.length > 0 && remaining.length > 0 && html`
      <p class="entity-options-heading entity-options-heading-all">${labels.all || 'All names'}</p>`}
    ${visible.map(entity => option(entity))}
    ${remaining.length > visible.length && html`
      <p class="entity-options-empty">
        ${`Showing ${visible.length} of ${remaining.length} matches — type to narrow the list`}
      </p>`}
    ${!entities.length && !pending.size && html`
      <p class="entity-options-empty">
        ${needle ? (labels.addHint || 'Press Enter to add this name')
          : (labels.noneExisting || 'No existing names')}
      </p>`}`;
}
