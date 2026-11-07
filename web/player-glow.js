import {glowHeldBack, playerGlowShown, setPlayerGlow} from './customisation.js';

/**
 * The glow's switch in the player's settings menu. When backing off has
 * turned the glow off on this device, the switch shows off with a warning
 * beside it; turning it back on tries again, and the warning leads to the
 * Performance setting that did it, which says why.
 */
export function createGlowSetting(row, {leave = () => {}, openAppearance} = {}) {
  const toggle = row.querySelector('[data-glow-toggle]');
  const warning = row.querySelector('[data-glow-warning]');
  function draw() {
    toggle.setAttribute('aria-checked', String(playerGlowShown()));
    warning.hidden = !glowHeldBack();
  }
  toggle.addEventListener('click', () => setPlayerGlow(!playerGlowShown()));
  warning.addEventListener('click', async () => {
    leave();
    // The drawer cannot show over a fullscreen player.
    if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
    openAppearance?.('performance-backoff');
  });
  window.addEventListener('archive-lighting-change', draw);
  draw();
  return {draw};
}
