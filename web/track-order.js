// How the audio bar chooses the track after the one that is playing: the run
// as listed, or shuffled, and what happens at either end of it. Kept apart
// from the player so the choosing can be tested without an element to play.

export const REPEAT_MODES = ['off', 'all', 'one'];

/** The mode after `mode` when the repeat button is pressed. */
export const nextRepeat = mode => REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];

/**
 * The run in a random order with the playing track first, so nothing before
 * it is owed a turn and "previous" has somewhere to go back to. `existing` is
 * kept as it is while it still holds exactly the run's tracks, so stepping
 * through a shuffle does not reshuffle it at every track.
 */
export function shuffleOrder(entries, currentId, existing = null, random = Math.random) {
  if (existing && existing.length === entries.length
      && entries.every(entry => existing.some(other => other.id === entry.id))
      && existing.some(entry => entry.id === currentId)) return existing;
  const rest = entries.filter(entry => entry.id !== currentId);
  for (let at = rest.length - 1; at > 0; at--) {
    const swap = Math.floor(random() * (at + 1));
    [rest[at], rest[swap]] = [rest[swap], rest[at]];
  }
  return [...entries.filter(entry => entry.id === currentId), ...rest];
}

/**
 * The track a step lands on, or null at an end. Only repeating the whole run
 * goes round the end; repeating one track is the player's to do when it
 * finishes, and a pressed next or previous still moves on from it.
 */
export function stepFrom(list, currentId, direction, repeat = 'off') {
  const index = list.findIndex(entry => entry.id === currentId);
  if (index < 0) return null;
  const at = index + direction;
  if (list[at]) return list[at];
  return repeat === 'all' && list.length > 1 ? list[(at + list.length) % list.length] : null;
}
