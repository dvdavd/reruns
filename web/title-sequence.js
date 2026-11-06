/**
 * Where a video sits in a numbered run, read from its title: "Part 3 of 5",
 * "Ep. 12", "S02E04", "Chapter IV", "(2/3)", "#7". Related videos use it to
 * put the next part first, since title overlap alone ranks every part of a
 * series the same and lists them in library order.
 *
 * Only the title is read. Uploaders number series in the title far more often
 * than yt-dlp's episode fields are filled in, and the title is what the person
 * sees, so it is what "the next one" should agree with.
 */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// Each word that numbers a run, and the kind of run it names, so "Pt 2" and
// "Part 3" are one series but "Day 2" and "Part 3" are not. "No" needs its
// full stop, or "no 2 people agree" would be a numbered run.
const KEYWORDS = {
  part: 'part', pt: 'part', episode: 'episode', ep: 'episode', chapter: 'chapter',
  chap: 'chapter', ch: 'chapter', volume: 'volume', vol: 'volume', day: 'day',
  lesson: 'lesson', week: 'week', session: 'session', round: 'round', book: 'book', 'no.': 'number',
};

// Digits may touch the keyword ("Ep3"), but a numeral or word must be set
// apart from it, or "Chi" would be chapter I.
const numberPattern = `\\d{1,4}|(?<=[\\s.#])(?:[ivx]+|${Object.keys(NUMBER_WORDS).join('|')})`;
const keywordPattern = Object.keys(KEYWORDS).sort((a, b) => b.length - a.length)
  .map(word => word.replace('.', '\\.')).join('|');

const SEASON_EPISODE = [
  /\bs(\d{1,2})\s*e(\d{1,3})\b/u,
  /\b(?:season|series)\s*(\d{1,2})\W{0,3}(?:episode|ep)\.?\s*(\d{1,3})\b/u,
];
// The trailing boundary is what stops "Part in" reading as "Part I".
const KEYWORD = new RegExp(`\\b(${keywordPattern})\\.?\\s*#?\\s*(${numberPattern})\\b`
  + '(?:\\s*(?:of|/)\\s*(\\d{1,4})\\b)?', 'u');
// A bare "3/5" is as often a date, so a slash only counts in brackets.
const BRACKETED_FRACTION = /[([]\s*(\d{1,4})\s*(?:\/|of)\s*(\d{1,4})\s*[)\]]/u;
const FRACTION = /\b(\d{1,4})\s+of\s+(\d{1,4})\b/u;
const HASH = /(?:^|\s)#(\d{1,4})\b/u;

const ROMAN = {i: 1, v: 5, x: 10};

function romanValue(text) {
  if (!/^x{0,3}(ix|iv|v?i{0,3})$/u.test(text)) return null;
  let total = 0;
  for (let index = 0; index < text.length; index++) {
    const value = ROMAN[text[index]];
    const next = ROMAN[text[index + 1]] || 0;
    total += value < next ? -value : value;
  }
  return total || null;
}

function numberValue(text) {
  if (/^\d+$/u.test(text)) return Number(text);
  return NUMBER_WORDS[text] ?? romanValue(text);
}

function normalise(title) {
  return String(title || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const wordsOf = text => text.match(/[\p{L}\p{N}]+/gu) || [];

function firstMarker(text) {
  for (const pattern of SEASON_EPISODE) {
    const match = pattern.exec(text);
    // Seasons sort ahead of episodes, so S02E01 follows S01E10.
    if (match) return {match, kind: 'season-episode', number: Number(match[1]) * 1000 + Number(match[2])};
  }
  const keyword = KEYWORD.exec(text);
  if (keyword) {
    const number = numberValue(keyword[2]);
    if (number != null) {
      return {match: keyword, kind: KEYWORDS[keyword[1]], number, total: Number(keyword[3]) || null};
    }
  }
  for (const pattern of [BRACKETED_FRACTION, FRACTION]) {
    const match = pattern.exec(text);
    if (match) return {match, kind: 'part', number: Number(match[1]), total: Number(match[2])};
  }
  const hash = HASH.exec(text);
  if (hash) return {match: hash, kind: 'number', number: Number(hash[1])};
  return null;
}

/**
 * The run a title numbers, or null. `prefix` is what comes before the marker,
 * which for "Series name - Part 3: Subtitle" is the series name; `words` is
 * the whole title without the marker, for titles that put it first.
 */
export function titleSequence(title) {
  const text = normalise(title);
  const marker = firstMarker(text);
  if (!marker || !(marker.number > 0)) return null;
  const {match, kind, number} = marker;
  const total = marker.total || null;
  if (total && number > total) return null;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return {
    kind, number, total,
    prefix: wordsOf(before).join(' '),
    words: new Set([...wordsOf(before), ...wordsOf(after)]),
  };
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return 2 * shared / (left.size + right.size);
}

/**
 * Whether two numbered titles are different parts of one run: the same kind
 * of number, no disagreement about how many there are, and either the same
 * name ahead of the number or mostly the same words around it. The same
 * number twice is a copy rather than another part, so it is not one.
 */
export function sameSeries(left, right) {
  if (!left || !right || left.kind !== right.kind || left.number === right.number) return false;
  if (left.total && right.total && left.total !== right.total) return false;
  if (left.prefix && left.prefix === right.prefix) return true;
  return overlap(left.words, right.words) >= 0.5;
}
