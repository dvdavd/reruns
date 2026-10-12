// One video (or feed) in a panel list: an optional leading index, a thumbnail,
// text, and a trailing group of actions. Downloads, browse results, the
// subscriptions drawer, the playlist editor and the watch queue all draw this,
// so a change to how a row looks is made once.
//
// The row owns the layout and the thumbnail; the app owns the words. Children
// are the body, usually a `.media-row-title` over a `.media-row-meta`. Where a
// row's own controls sit beside part of its body rather than at its edge (a
// download's buttons sit by its progress bar), they go in the children and
// `actions` is left out.
import {html} from '../lib/html.js';

const hideBroken = event => { event.currentTarget.hidden = true; };
const showLoaded = event => { event.currentTarget.hidden = false; };

export function MediaRow({
  // The element, so a row that is itself a control can be a <button>.
  as: Tag = 'li',
  // `regular` is the 112px thumbnail of the downloads panel; `compact` the 64px
  // one of the editor, the queue and subscriptions.
  size = 'regular',
  // How many lines a title may take before it is clamped.
  lines = 2,
  // A channel's avatar is a circle, not a frame.
  round = false,
  // Whether the row sits over a rule. A row that highlights on hover does not.
  divided = true,
  lead,
  thumbnail,
  // Stands in when there is no picture: an icon, say.
  fallback,
  duration,
  // Overhangs the thumbnail's corner (a count of new videos).
  badge,
  actions,
  class: className = '',
  children,
  ...rest
}) {
  const classes = ['media-row', divided && 'media-row--divided', className].filter(Boolean).join(' ');
  return html`
    <${Tag} class=${classes} data-size=${size} data-round=${round ? 'true' : undefined}
            style=${{'--media-row-lines': lines}} ...${rest}>
      ${lead != null && html`<span class="media-row-lead">${lead}</span>`}
      <span class="media-row-thumb">
        ${thumbnail
          ? html`<img src=${thumbnail} alt="" loading="lazy" referrerpolicy="no-referrer"
                      onError=${hideBroken} onLoad=${showLoaded} />`
          : fallback}
        ${duration && html`<span class="media-row-duration">${duration}</span>`}
        ${badge}
      </span>
      <div class="media-row-body">${children}</div>
      ${actions && html`<div class="media-row-actions">${actions}</div>`}
    <//>`;
}
