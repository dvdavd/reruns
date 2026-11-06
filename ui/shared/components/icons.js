// Shared SVG glyphs live in ../icons.svg. Keep styling on each instance.
import {html} from '../lib/html.js';

let spriteUrl = new URL('../icons.svg', import.meta.url).href;

export function setIconSpriteUrl(url) {
  spriteUrl = String(url);
}

export const iconHref = name => `${spriteUrl}#${name}`;

export const EyeIcon = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon icon-tabler icons-tabler-outline icon-tabler-eye"><use href=${iconHref('eye')} /></svg>`;

export const HeartOutline = () => html`<svg class="heart-icon heart-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href=${iconHref('heart-outline')} /></svg>`;

export const HeartFilled = () => html`<svg class="heart-icon heart-filled" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><use href=${iconHref('heart-filled')} /></svg>`;

export const ChevronLeft = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon icon-tabler icons-tabler-outline icon-tabler-chevron-left"><use href=${iconHref('chevron-left')} /></svg>`;

export const ChevronRight = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon icon-tabler icons-tabler-outline icon-tabler-chevron-right"><use href=${iconHref('chevron-right')} /></svg>`;

export const StackIcon = () => html`<svg viewBox="3 5 18 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon icon-tabler icons-tabler-outline icon-tabler-stack"><use href=${iconHref('stack')} /></svg>`;

export const MenuDots = () => html`<svg class="icon" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true"><use href=${iconHref('menu-dots')} /></svg>`;

export const InfoIcon = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href=${iconHref('info')} /></svg>`;

export const PencilIcon = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><use href=${iconHref('pencil')} /></svg>`;

export const TrashIcon = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><use href=${iconHref('trash')} /></svg>`;

export const PortraitRefreshIcon = () => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"><use href=${iconHref('portrait-refresh')} /></svg>`;

const MENU_ICONS = {"edit-groups": "edit-groups", "edit": "edit", "choose-thumbnail": "choose-thumbnail", "copy": "copy", "delete": "trash", "source": "external-link", "subscribe": "bell", "save-file": "device-floppy", "download-format": "download", "add-playlist": "playlist-add", "show-playlists": "playlist"};

export const MenuIcon = ({name}) => html`
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${MENU_ICONS[name] && html`<use href=${iconHref(MENU_ICONS[name])} />`}
  </svg>`;
