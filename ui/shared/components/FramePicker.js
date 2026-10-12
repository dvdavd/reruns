// The grid of candidate frames shown when choosing an item's thumbnail. Both
// apps pick a frame from a strip of samples taken across a video, and both
// have VR material to pick from — YouTube hosts 180/360 too — so a recentred
// frame's yaw and pitch, and alpha-packed previews, are modelled here rather
// than treated as this app's private concern. That matches the shared item
// shape, which already carries projection, layout and alpha packing.
//
// What stays injected is what each app words or routes differently: how a
// frame's URL is built, what extra attributes its handlers read, and the
// caption, since only the app knows whether it counts faces or chapters.
//
// The old renderer diffed by hand, comparing a JSON "render signature" per
// slot so a streaming thumbnail did not replace DOM that had not changed.
// Keying each slot gives that for free, and the arriving animation still
// only plays when a real frame replaces a placeholder.
import {html} from '../lib/html.js';

/** A slot still waiting on the server, or one the batch could not produce. */
const Placeholder = ({generating, labels}) => html`
  <button type="button" class="thumbnail-candidate is-placeholder" disabled>
    <span class="thumbnail-candidate-placeholder">
      ${generating && html`<span class="thumbnail-picker-spinner" aria-hidden="true"></span>`}
    </span>
    <span>${generating ? (labels.generating || 'Generating…') : (labels.unavailable || 'Unavailable')}</span>
  </button>`;

const Candidate = ({frame, selected, arriving, alpha, dataset, imageUrl, caption}) => html`
  <button type="button"
          class=${['thumbnail-candidate',
                   alpha ? 'is-alpha' : '',
                   selected ? 'is-selected' : '',
                   arriving ? 'is-arriving' : ''].filter(Boolean).join(' ')}
          disabled=${frame.state !== 'ready'}
          ...${dataset}>
    <img src=${imageUrl || undefined} alt=${`${Math.round(Number(frame.percent))}% through the video`} />
    <span>${caption}</span>
  </button>`;

/**
 * Renders `slotCount` slots, filling them from `frames` and padding the rest
 * with placeholders so the grid does not reflow as results stream in.
 *
 * A frame may carry `yaw`/`pitch` when it has been recentred; `frameRevision`
 * turns those into the cache key a re-framed thumbnail needs, so both apps get
 * that for free. `imageUrlFor` and `datasetFor` remain the routing seams.
 */
export function FramePicker({
  frames = [],
  slotCount = 12,
  selectedPercent = null,
  generating = false,
  alpha = false,
  // Which slots held a placeholder last time, so a frame landing in one can
  // animate in. The caller owns this because only it knows the previous state.
  arrivingAt = () => false,
  imageUrlFor = frame => (frame.url
    ? `${frame.url}&revision=${encodeURIComponent(frameRevision(frame))}` : null),
  datasetFor = frame => ({
    'data-percent': String(frame.percent),
    ...(frame.yaw != null ? {'data-yaw': String(frame.yaw)} : {}),
    ...(frame.pitch != null ? {'data-pitch': String(frame.pitch)} : {}),
  }),
  captionFor = null,
  labels = {},
}) {
  const caption = captionFor || (frame => defaultCaption(frame, labels));
  return Array.from({length: slotCount}, (_, index) => {
    const frame = frames[index];
    if (!frame) {
      return html`<${Placeholder} key=${`slot:${index}`} generating=${generating} labels=${labels} />`;
    }
    return html`
      <${Candidate} key=${`frame:${frame.percent}`} frame=${frame}
                    selected=${selectedPercent != null
                      && Number(selectedPercent) === Number(frame.percent)}
                    arriving=${arrivingAt(index)}
                    alpha=${alpha}
                    dataset=${datasetFor(frame)}
                    imageUrl=${imageUrlFor(frame)}
                    caption=${caption(frame)} />`;
  });
}

/**
 * The cache key for a frame's image. A recentred frame is served from the same
 * URL as the original, so the angles it was framed at have to distinguish it.
 */
export function frameRevision(frame) {
  return frame.centered ? `centered-${frame.yaw}-${frame.pitch}` : 'original';
}

/** "42%" once ready, and what went wrong otherwise. */
export function defaultCaption(frame, labels = {}) {
  if (frame.error) return labels.failed || 'Failed';
  if (frame.state !== 'ready') return labels.analysing || 'Analysing frames…';
  return `${Math.round(Number(frame.percent))}%`;
}
