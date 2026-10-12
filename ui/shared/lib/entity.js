// The shared shape for a taggable entity — the things videos are filed under.
// This app has actors and studios; the archival client has contributors and
// channels. The components below see only this shape, never those names.
//
//   id          stable identifier
//   name        the display name, and what a filter matches on
//   itemCount   how many library items reference it
//   favourite   whether the viewer has starred it (people only)
//   portrait    whether this kind of entity shows an image
//
// `kind` carries the app's own vocabulary for labelling: a catalogue of
// people reads differently from a catalogue of owners, and only the app
// knows which words to use.

/** The default labels a catalogue renders, overridable per app. */
export const DEFAULT_ENTITY_LABELS = {
  singular: 'entry',
  plural: 'entries',
  itemSingular: 'item',
  itemPlural: 'items',
  view: name => `View items for ${name}`,
  rename: 'Rename',
  remove: 'Delete',
  removeEntry: 'Delete entry',
  removeAssociations: 'Remove associations',
  noReassignment: 'No reassignment needed',
  regeneratePortrait: 'Regenerate portrait',
  cancel: 'Cancel',
  save: 'Save',
  empty: 'No entries yet.',
  noMatches: 'No matching entries.',
};

/** "3 videos" / "1 video", pluralised on the app's own noun. */
export function countLabel(count, labels = DEFAULT_ENTITY_LABELS) {
  const noun = count === 1 ? labels.itemSingular || 'item' : labels.itemPlural || 'items';
  return `${count} ${noun}`;
}

/**
 * The prompt shown before deleting. An entity with references needs the
 * viewer to decide what happens to them; one without can simply go.
 */
export function deletionPrompt(entity, labels = DEFAULT_ENTITY_LABELS) {
  return entity.itemCount
    ? `Reassign ${countLabel(entity.itemCount, labels)} before deleting?`
    : 'This entry has no associated items.';
}

/** Normalises a catalogue row into the shared shape. */
export function toEntity(raw, {portrait = false} = {}) {
  return {
    id: raw.id,
    name: raw.name || '',
    itemCount: Number(raw.itemCount ?? raw.video_count ?? 0),
    favourite: Boolean(raw.favourite),
    portrait,
  };
}
