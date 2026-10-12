// A selection of design/palettes' samples: the logo's gradient and the accent
// buttons take. They run round the wheel, from yellow through red, pink and
// blue to green, so neighbours shade into each other; Rainbow, being all of
// them, comes last. Cooler is what the stylesheet already spells out, so
// choosing it clears the overrides rather than restating them. Original is
// the default, so it is applied like the rest, and the stylesheet's colours
// show only for the moment before the first visit has stored it.
export const PALETTES = {
  ember: {name: 'Ember', stops: ['#facc15', '#f97316', '#dc2626'], accent: '#f97316'},
  ruby: {name: 'Ruby', stops: ['#fb7185', '#e11d48', '#7f1d1d'], accent: '#e11d48'},
  original: {name: 'Original', stops: ['#ff7a0f', '#f0307c', '#7a38e8'], accent: '#e83a68'},
  cooler: {name: 'Cooler', stops: ['#db2777', '#9333ea', '#4338ca'], accent: '#9333ea'},
  dusk: {name: 'Dusk', stops: ['#6366f1', '#c026d3', '#fb923c'], accent: '#c026d3'},
  synthwave: {name: 'Synthwave', stops: ['#06b6d4', '#8b5cf6', '#ec4899'], accent: '#8b5cf6'},
  ice: {name: 'Ice', stops: ['#67e8f9', '#3b82f6', '#1e3a8a'], accent: '#3b82f6'},
  ocean: {name: 'Ocean', stops: ['#0d9488', '#0284c7', '#4f46e5'], accent: '#0284c7'},
  aurora: {name: 'Aurora', stops: ['#a3e635', '#06b6d4', '#7c3aed'], accent: '#06b6d4'},
  mint: {name: 'Mint & teal', stops: ['#34d399', '#14b8a6', '#0e7490'], accent: '#0f9f8f'},
  forest: {name: 'Forest', stops: ['#65a30d', '#15803d', '#115e59'], accent: '#15803d'},
  citrus: {name: 'Citrus', stops: ['#eab308', '#84cc16', '#059669'], accent: '#65a30d'},
  tropical: {name: 'Tropical', stops: ['#fb923c', '#e11d84', '#0891b2'], accent: '#e11d84'},
  graphite: {name: 'Graphite', stops: ['#d4d4d8', '#71717a', '#3f3f46'], accent: '#71717a'},
  rainbow: {name: 'Rainbow', stops: ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'], accent: '#3b82f6', spread: 1},
};
// Keep the palette's full chroma through the logo and controls.
const CHROMA = 1;
export const soften = colour => `oklch(from ${colour} l calc(c * ${CHROMA}) h)`;
const mix = (a, b, share) => soften(`color-mix(in oklch, ${a} ${100 - share}%, ${b})`);
// Each stop is drawn part of the way to the palette's middle one, so the ends
// sit closer together and the gradient shifts less from side to side. The
// middle stop, and so the accent's hue, is untouched.
// Rainbow opts out with a spread of 1: its point is to run the whole wheel, and
// drawing red and violet towards green only muddies it.
const SPREAD = .65;
const narrow = (stops, spread = SPREAD) => stops.map(stop => `color-mix(in oklch, ${stop} ${Math.round(spread * 100)}%, ${stops[Math.floor(stops.length / 2)]})`);
export const paletteGradient = ({stops, spread}) => `linear-gradient(in oklch to right, ${narrow(stops, spread).map(soften).join(', ')})`;

/** The colour a way along a palette's gradient, 0 to 1, blended in OKLCH. */
export function gradientAt(wide, position, spread) {
  const stops = narrow(wide, spread);
  const t = position * (stops.length - 1);
  const from = Math.min(Math.floor(t), stops.length - 2);
  return mix(stops[from], stops[from + 1], Math.round((t - from) * 100));
}

/** What a palette sets on the page: the custom properties, and the colour of
    each of the logo gradient's `count` evenly spaced stops. SVG gradients blend
    in sRGB, so the stops are each mixed in OKLCH here to keep the blend from
    greying. The four logo tokens are the stops between the ends and the middle. */
export function paletteStyle(key, count) {
  const {stops, accent, spread} = PALETTES[key];
  const at = position => gradientAt(stops, position, spread);
  return {
    properties: {
      '--button-hue': soften(accent),
      // The same colour under a name the watch page's video accent does not override, for the
      // Adaptive watch page theme previews, which must show the chosen theme while a video is open.
      '--theme-hue': soften(accent),
      // Text highlights keep the stylesheet's darker lightness. Filled buttons keep the source lightness
      // and choose their own foreground colour.
      '--color-accent': `oklch(from ${accent} .56 min(calc(c * ${CHROMA}), .24) h)`,
      '--color-accent-strong': `oklch(from ${accent} .47 min(calc(c * ${CHROMA}), .22) h)`,
      '--logo-gradient': paletteGradient(PALETTES[key]),
      ...Object.fromEntries([1, 3, 5, 7].map((eighth, index) => [`--logo-${index + 1}`, at(eighth / 8)])),
    },
    stops: Array.from({length: count}, (_, index) => at(index / (count - 1))),
  };
}
