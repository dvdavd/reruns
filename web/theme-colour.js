// The browser's own chrome (a phone's address bar, an installed app's title
// bar) is drawn in the page's background colour rather than its default. The
// head script of each page sets it before first paint from the stored theme;
// this keeps it true afterwards, whoever changes data-theme: the Appearance
// drawer, System following the OS, or the admin's default arriving with the
// config. Only light and dark move the background, so the palette and video
// colours are left alone.
export function followThemeColour(root = document.documentElement) {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  const sync = () => {
    const colour = getComputedStyle(document.body).backgroundColor;
    if (colour && meta.content !== colour) meta.content = colour;
  };
  sync();
  new MutationObserver(sync).observe(root, {attributes: true, attributeFilter: ['data-theme']});
}
