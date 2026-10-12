// A row in the entity catalogue: one actor or studio here, one contributor or
// channel in the archival client. The row carries its rename form and delete
// panel inline, both hidden until the matching action is chosen.
//
// Interactions still reach the delegated listeners on document, so the row
// keeps the data-* attributes those read. The app supplies the vocabulary
// through `labels`; nothing here knows what the entities are called.
import {html} from '../lib/html.js';
import {DEFAULT_ENTITY_LABELS, countLabel, deletionPrompt} from '../lib/entity.js';
import {PencilIcon, PortraitRefreshIcon, TrashIcon} from './icons.js';

const Identity = ({entity, labels, filterAttribute, portraitAttributes}) => html`
  <div class="entity-identity">
    <button type="button" class="entity-identity-link"
            ...${{[filterAttribute]: entity.name}}
            aria-label=${labels.view(entity.name)}>
      ${entity.portrait && html`
        <span class="entity-portrait">
          <img ...${portraitAttributes(entity)} alt="" hidden />
        </span>`}
      <strong>${entity.name}</strong>
    </button>
    <span class="entity-count-chip">${countLabel(entity.itemCount, labels)}</span>
  </div>`;

const Actions = ({entity, labels}) => html`
  <div class="entity-actions">
    ${entity.portrait && html`
      <button type="button" data-entity-action="regenerate-portrait"
              class="entity-icon-button" title=${labels.regeneratePortrait}
              aria-label=${`${labels.regeneratePortrait} ${entity.name}`}>
        <${PortraitRefreshIcon} />
      </button>`}
    <button type="button" data-entity-action="rename" class="entity-icon-button"
            title=${labels.rename} aria-label=${`${labels.rename} ${entity.name}`}>
      <${PencilIcon} />
    </button>
    <button type="button" data-entity-action="delete" class="entity-icon-button danger"
            title=${labels.remove} aria-label=${`${labels.remove} ${entity.name}`}>
      <${TrashIcon} />
    </button>
  </div>`;

export function EntityRow({
  entity,
  labels: overrides = {},
  // Which attribute the identity button carries, since it is what the library
  // filter listens for: data-actor-filter here, data-channel-filter elsewhere.
  filterAttribute = 'data-entity-filter',
  // What the lazy-loading observer needs stamped on the portrait image. This
  // app's loader reads data-actor-portrait and data-actor-id; another app's
  // will read its own, so the row does not presume either.
  portraitAttributes = entity => ({'data-entity-portrait': '', 'data-entity-id': entity.id}),
}) {
  const labels = {...DEFAULT_ENTITY_LABELS, ...overrides};
  return html`
    <div class="entity-row" data-entity-id=${entity.id}>
      <div class="entity-row-heading">
        <${Identity} entity=${entity} labels=${labels} filterAttribute=${filterAttribute}
                     portraitAttributes=${portraitAttributes} />
        <${Actions} entity=${entity} labels=${labels} />
      </div>

      <form class="entity-inline-form" data-entity-rename hidden>
        <input type="text" value=${entity.name} maxLength="200" required />
        <button type="submit">${labels.save}</button>
        <button type="button" data-entity-action="cancel">${labels.cancel}</button>
      </form>

      <div class="entity-delete-panel" data-entity-delete hidden>
        <p>${deletionPrompt(entity, labels)}</p>
        <div class="entity-inline-form">
          <select data-entity-replacement hidden=${!entity.itemCount}>
            <option value="">
              ${entity.itemCount ? labels.removeAssociations : labels.noReassignment}
            </option>
          </select>
          <button type="button" class="danger" data-entity-action="confirm-delete">
            ${labels.removeEntry}
          </button>
          <button type="button" data-entity-action="cancel">${labels.cancel}</button>
        </div>
      </div>
    </div>`;
}
