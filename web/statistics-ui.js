import {formatBytes, html, render} from 'media-ui';
import {createDrawerControls} from './drawer.js';
import {formatRuntime, libraryStats} from './library-stats.js';
import {plural, t} from './i18n.js';


export function createStatisticsUI({drawer, drawerClose, scopeSwitch, subtitle, stats, items, currentView, facetLink, playVideo}) {
  const controls = createDrawerControls(drawer);
  let metric = 'count';
  let scope = 'library';
  const metrics = () => [['count', t('stats.videos')], ['sizeBytes', t('stats.size')], ['durationSeconds', t('stats.runtime')]];

  // A channel or playlist name opens its gallery, closing the drawer first so
  // the gallery it opens is not hidden behind it.
  function facetName(kind, target, label = target.name) {
    const link = facetLink(kind, target);
    return html`<a href=${link.href} onClick=${event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      controls.close();
      link.open();
    }}>${label}</a>`;
  }

  // Each ranking measures one thing, so its bars share one hue and differ only
  // in length, scaled to the largest in the list. The number stays as text
  // beside the bar: the bar is for comparing, the text for reading.
  function bars(title, entries, ranking = false) {
    if (!entries.length) return null;
    const largest = Math.max(...entries.map(entry => entry.value)) || 1;
    return html`<section class="about-section">
      <div class="statistics-section-heading"><h3>${title}</h3>
      ${ranking ? html`<div class="statistics-ranking" role="group" aria-label=${t('stats.rankBy', {section: title.toLowerCase()})}>
        ${metrics().map(([key, label]) => html`<button type="button" aria-pressed=${metric === key}
          onClick=${() => { metric = key; showStats(); }}>${label}</button>`)}
      </div>` : null}</div>
      <ol class="about-bars">${entries.map((entry, index) => html`<li class="about-bar" key=${index}
          title=${entry.tooltip || null}>
        <span class="about-bar-name">${entry.name}</span>
        <span class="about-bar-value">${entry.label}</span>
        <span class="about-bar-track" aria-hidden="true">
          <span class="about-bar-fill" style=${`width: ${entry.value / largest * 100}%`}></span>
        </span>
        ${entry.completion ? html`<span class="statistics-completion">${entry.completion.label}
          <span class="about-bar-track" role="progressbar" aria-label=${t('stats.completion')}
            aria-valuemin="0" aria-valuemax="100" aria-valuenow=${entry.completion.percent}>
            <span class="about-bar-fill" style=${`width: ${entry.completion.percent}%`}></span>
          </span></span>` : null}
      </li>`)}</ol>
    </section>`;
  }

  function tiles(entries) {
    const tile = ([name, value]) => html`<div class="about-tile" key=${name}>
      <dt>${name}</dt><dd>${value}</dd>
    </div>`;
    return html`<section class="about-section">
      <h3>${scope === 'library' ? t('stats.library') : t('stats.currentView')}</h3>
      <dl class="about-tiles statistics-primary">${entries.slice(0, 3).map(tile)}</dl>
      <dl class="statistics-secondary">${entries.slice(3).map(tile)}</dl>
    </section>`;
  }

  function qualityMix(found) {
    if (!found.qualities.length) return null;
    const colours = ['#6488e8', '#39a99a', '#bd83d4', '#d39b46', '#dc778c', '#8496aa'];
    const share = count => `${Math.round(count / found.videos * 100)}%`;
    return html`<section class="about-section">
      <h3>${t('stats.quality')}</h3>
      <div class="statistics-quality-bar" aria-label=${t('stats.qualityBar')}>
        ${found.qualities.map(({id, name, count}, index) => {
          const link = facetLink('quality', {id, name});
          return html`<a key=${id} href=${link.href}
            style=${`flex: ${count}; background: ${colours[index % colours.length]}`}
            title=${`${name}: ${plural('count.videos', count)} · ${share(count)}`}
            aria-label=${`${name}: ${plural('count.videos', count)} · ${share(count)}`}
            onClick=${event => {
              if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault(); controls.close(); link.open();
            }}></a>`;
        })}
      </div>
      <ul class="statistics-quality-legend">${found.qualities.map(({id, name, count}, index) => html`<li key=${id}>
        <span class="statistics-quality-dot" aria-hidden="true"
          style=${`background: ${colours[index % colours.length]}`}></span>
        ${facetName('quality', {id, name})}
        <span class="about-bar-value">${count} · ${share(count)}</span>
      </li>`)}</ul>
    </section>`;
  }

  function showStats() {
    const view = currentView();
    const found = libraryStats(scope === 'library' ? items() : view.items, metric);
    const rankedLabel = entry => metric === 'count' ? plural('count.videos', entry.count)
      : metric === 'sizeBytes' ? formatBytes(entry.sizeBytes) : formatRuntime(entry.durationSeconds);
    // What the totals are of, under the title where a subtitle would be.
    subtitle.textContent = scope === 'library' ? t('stats.allArchived') : view.label;
    render([['library', t('stats.library')], ['view', t('stats.view')]].map(([key, label]) => html`<button
      type="button" key=${key} aria-pressed=${scope === key} onClick=${() => { scope = key; showStats(); }}>${label}</button>`),
      scopeSwitch);
    render(html`
      ${tiles([
        [t('stats.videos'), found.videos],
        [t('stats.storage'), formatBytes(found.sizeBytes)],
        [t('stats.runtime'), formatRuntime(found.durationSeconds)],
        [t('stats.channels'), found.channels],
        [t('stats.playlists'), found.playlists],
        [t('stats.favourites'), facetName('favourite', {id: 'true', name: t('stats.favourites')}, String(found.favourites))],
      ])}
      ${!found.videos ? html`<p class="statistics-empty" role="status">${scope === 'library'
        ? t('stats.noneLibrary') : t('stats.noneView')}</p>` : null}
      ${qualityMix(found)}
      ${bars(t('stats.topChannels'), found.topChannels.map(channel => ({
        name: facetName('channel', channel), value: channel[metric],
        label: rankedLabel(channel)})), true)}
      ${bars(t('stats.largestPlaylists'), found.topPlaylists.map(playlist => ({
        name: facetName('playlist', {id: playlist.id, name: playlist.title}), value: playlist[metric],
        label: rankedLabel(playlist),
        completion: {percent: Math.round(playlist.count / playlist.total * 100),
          label: t('stats.downloaded', {count: playlist.count, total: playlist.total,
            percent: Math.round(playlist.count / playlist.total * 100)})},
      })), true)}
      ${bars(t('stats.largestVideos'), found.largestVideos.map(({item, sizeBytes}) => ({
        name: html`<a href=${`?watch=${encodeURIComponent(item.id)}`} onClick=${event => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); controls.close(); playVideo(item, event);
        }}>${item.title}</a>`, tooltip: item.title, value: sizeBytes, label: formatBytes(sizeBytes)})))}`, stats);
  }

  function open() {
    showStats();
    controls.open();
  }

  drawerClose.addEventListener('click', controls.close);
  return {open};
}
