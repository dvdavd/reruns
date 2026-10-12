/**
 * Menu entries with the dividers that no longer separate anything taken out.
 * Entries are filtered by permission and by what an item has, so a divider can
 * end up first, last or beside another one; each such divider is dropped.
 */
export function withoutStrayDividers(entries) {
  const tidy = [];
  for (const entry of entries) {
    if (entry.type === 'divider' && (!tidy.length || tidy.at(-1).type === 'divider')) continue;
    tidy.push(entry);
  }
  while (tidy.at(-1)?.type === 'divider') tidy.pop();
  return tidy;
}
