import {html, MediaRow} from 'media-ui';
import {icon} from './icon.js';
import {t} from './i18n.js';
import {formatDuration, stateLabel} from './download-model.js';

function rowActions(row, onAction) {
  const {pause, resume, retry, stopSave, discard, remaining} = row.actions;
  const many = remaining > 1;
  const batch = {count: remaining};
  const word = (one, all) => t(many ? all : one, batch);
  return html`<div class="download-row-actions">
    ${pause ? html`<button type="button" class="download-row-action"
      title=${word('downloads.pauseTitle', 'downloads.pauseAllTitle')}
      aria-label=${word('downloads.pause', 'downloads.pauseAll')}
      onClick=${() => onAction(row.jobId, 'pause')}>${icon('pause', 'is-solid')}</button>` : null}
    ${resume ? html`<button type="button" class="download-row-action"
      title=${word('downloads.resume', 'downloads.resumeAll')} aria-label=${word('downloads.resume', 'downloads.resumeAll')}
      onClick=${() => onAction(row.jobId, 'resume')}>${icon('play', 'is-solid')}</button>` : null}
    ${retry ? html`<button type="button" class="download-row-action"
      title=${t('downloads.retry')} aria-label=${t('downloads.retry')}
      onClick=${() => onAction(row.jobId, 'resume')}>${icon('play', 'is-solid')}</button>` : null}
    ${stopSave ? html`<button type="button" class="download-row-action"
      title=${t('downloads.stopSave')} aria-label=${t('downloads.stopSave')}
      onClick=${() => onAction(row.jobId, 'stop_save')}>${icon('download')}</button>` : null}
    ${!retry ? html`<button type="button" class="download-row-action danger"
      title=${discard ? t('downloads.discard') : word('downloads.cancel', 'downloads.cancelAll')}
      aria-label=${discard ? t('downloads.discard') : word('downloads.cancel', 'downloads.cancelAll')}
      onClick=${() => onAction(row.jobId, discard ? 'discard' : 'cancel')}>${icon('trash')}</button>` : null}
  </div>`;
}

/** The same job row in the queue and beside the listing that started it.
 *  A listing supplies its known details until yt-dlp has inspected the job. */
export function downloadRow(row, {onAction, entry = null, key = row.key, local = null} = {}) {
  const title = row.pendingMetadata && entry ? entry.title : row.title;
  const thumbnail = row.thumbnail || entry?.thumbnail;
  const duration = row.duration || formatDuration(entry?.duration);
  const channel = row.channel || (row.pendingMetadata ? entry?.uploader : '');
  const known = row.percent !== null && row.state !== 'done';
  const indeterminate = row.indeterminate && row.state !== 'done';
  return html`<${MediaRow} key=${key} class="download-row" data-state=${row.state}
    thumbnail=${thumbnail} duration=${duration}>
    ${local ? html`<a class="media-row-title" href=${local.href}
      title=${t('downloads.playLocal')} onClick=${local.onClick}>${title}</a>`
      : entry ? html`<a class="media-row-title" href=${entry.url} target="_blank"
      rel="noreferrer noopener" title=${t('subscriptions.openOriginal')}>${title}</a>`
      : html`<span class="media-row-title" title=${row.source}>${title}</span>`}
    ${row.pendingMetadata && !entry ? html`
      <p class="download-pending-source" title=${row.source}>${row.source}</p>
      ${row.settings ? html`<p class="download-pending-settings">${row.settings}</p>` : null}
    ` : null}
    ${channel ? html`<p class="media-row-meta"><span>${channel}</span></p>` : null}
    ${row.format ? html`<p class="download-row-format">${row.format}</p>` : null}
    ${(row.formatNotes || []).map(note => html`<p class="download-row-format-note"
      data-level=${note.level}>${note.text}</p>`)}
    <div class="download-row-foot">
      <div class="download-row-status">
        <p class="download-row-detail" data-error=${String(row.error)}>${row.detail}</p>
        ${known ? html`<div class="download-track" role="progressbar" aria-valuemin="0"
          aria-valuemax="100" aria-valuenow=${Math.round(row.percent)}
          aria-label=${`${title}: ${stateLabel(row.state)}`}>
          <div class="download-bar" style=${`width:${row.percent}%`}></div></div>`
          : indeterminate ? html`<div class="download-track is-indeterminate" role="progressbar"
            aria-label=${`${title}: ${row.detail}`}>
            <div class="download-bar"></div></div>` : null}
      </div>
      ${row.actions && onAction ? rowActions(row, onAction) : null}
    </div>
  <//>`;
}
