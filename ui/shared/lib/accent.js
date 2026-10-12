// The card accent picker: the one colour a thumbnail or portrait lends to the
// card around it. Pictures without an accent are sampled over a tiny copy
// drawn to a canvas.
//
// The extraction prefers non-yellow
// colours. Yellow remains a fallback and is lifted for the card surfaces;
// consumers publishing server-side accents may still supply the original colours.

// Width of the centre slice the accent is picked from, and the share of that
// slice its winning hue bucket must cover to be taken as the key colour rather
// than a stray highlight.
export const CENTRE_FRACTION = 0.3;
export const CENTRE_MIN_SHARE = 0.005;
// Pixels flatter than this are surfaces, not colour. The floor also sets the
// zero point of the vividness weighting, so raising it both excludes more and
// sharpens the preference among what survives.
export const MIN_SATURATION = 0.22;
// A winning bin using less than this share of the chroma available at its own
// lightness is a tinted surface, not a colour, and publishing it would invent
// a hue the image does not contain.
export const MIN_CHROMA_RATIO = 0.35;
// Most hues share a mid lightness. Yellow needs more lightness to retain its
// colour rather than turning olive; the lift tapers into orange and green.
// Chroma is capped so a saturated subject cannot overpower the card chrome.
export const LIGHTNESS = 0.62;
export const MAX_CHROMA = 0.19;

/**
 * Bin one region's usable pixels by hue, returning the non-skin and skin
 * histograms separately so a caller can ignore skin entirely or fall back to
 * it. Bins are keyed on hue alone: keying on saturation as well splits one
 * vivid object across several bins while a flat dull wall stays in one, which
 * hands the wall the vote.
 */
function binsOf(pixels) {
  const bins = [new Map(), new Map()];
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [red, green, blue] = pixels.slice(offset, offset + 3);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const lightness = (maximum + minimum) / 510;
    const saturation = maximum === minimum ? 0
      : (maximum - minimum) / (255 - Math.abs(maximum + minimum - 255));
    if (lightness < .12 || lightness > .9 || saturation < MIN_SATURATION) continue;
    const delta = maximum - minimum;
    let hue = maximum === red ? 60 * (((green - blue) / delta) % 6)
      : maximum === green ? 60 * ((blue - red) / delta + 2)
        : 60 * ((red - green) / delta + 4);
    hue = (hue + 360) % 360;
    const skin = hue <= 55 && red > green && green > blue && red - blue > 20
      && red - green > 8 && saturation >= .2 && saturation <= .75;
    // Vividness, not area, should decide. A linear term lets a wall covering
    // half the frame outvote a small saturated object simply by pixel count;
    // squaring the margin over the floor makes one vivid pixel worth many
    // barely-qualifying ones, and biases the bin's own mean towards its most
    // saturated members.
    const weight = (saturation - MIN_SATURATION) ** 2 * (1 - Math.abs(lightness - .55));
    const key = Math.floor(hue / 15);
    const bucket = bins[skin ? 1 : 0].get(key) || [0, 0, 0, 0];
    bucket[0] += weight;
    bucket[1] += red * weight;
    bucket[2] += green * weight;
    bucket[3] += blue * weight;
    bins[skin ? 1 : 0].set(key, bucket);
  }
  return bins;
}

/** The OKLCh lightness, chroma and hue of one weighted RGB bucket. */
function oklch(bucket) {
  const linear = value => {
    value /= 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const [, weightedRed, weightedGreen, weightedBlue] = bucket;
  const rgb = [weightedRed, weightedGreen, weightedBlue]
    .map(value => linear(value / bucket[0]));
  const l = Math.cbrt(.4122214708 * rgb[0] + .5363325363 * rgb[1] + .0514459929 * rgb[2]);
  const m = Math.cbrt(.2119034982 * rgb[0] + .6806995451 * rgb[1] + .1073969566 * rgb[2]);
  const s = Math.cbrt(.0883024619 * rgb[0] + .2817188376 * rgb[1] + .6299787005 * rgb[2]);
  const a = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s;
  const b = .0259040371 * l + .7827717662 * m - .808675766 * s;
  return [.2104542553 * l + .793617785 * m - .0040720468 * s,
    Math.hypot(a, b), (Math.atan2(b, a) * 180 / Math.PI + 360) % 360];
}

/** The most chroma the sRGB gamut holds at one lightness and hue. */
function maxChroma(lightness, hue) {
  const radians = hue * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const inGamut = chroma => {
    const a = chroma * cosine, b = chroma * sine;
    const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3;
    const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3;
    const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621*l - 3.3077115913*m + .2309699292*s,
      -1.2684380046*l + 2.6097574011*m - .3413193965*s,
      -.0041960863*l - .7034186147*m + 1.707614701*s]
      .every(channel => channel >= -.0001 && channel <= 1.0001);
  };
  let low = 0, high = .4;
  for (let index = 0; index < 24; index++) {
    const middle = (low + high) / 2;
    if (inGamut(middle)) low = middle; else high = middle;
  }
  return low;
}

/**
 * Pick the heaviest bin that names a colour actually in the region.
 *
 * The card normalises accent lightness so the gallery stays even, which
 * means the bin's own chroma cannot be carried over directly: a deep red at 99%
 * of the chroma available to it publishes as a washed out brick once lifted to
 * a mid lightness where far more chroma is on offer. Carry over how saturated
 * the colour was *for its lightness* instead, and reject bins too flat to be
 * naming a colour at all - a cream wall under warm light would otherwise
 * arrive as vivid khaki.
 */
function accentFromBins(bins, floor = 0, avoidYellow = false) {
  for (const bucket of [...bins.values()].sort((a, b) => b[0] - a[0])) {
    // Pixels sitting exactly on the saturation floor weigh nothing, so a bin
    // can hold members and still total zero. Sorted descending, everything
    // past the first is just as empty.
    if (bucket[0] <= 0 || bucket[0] < floor) break;
    const [lightness, chroma, hue] = oklch(bucket);
    if (avoidYellow && hue >= 85 && hue <= 120) continue;
    const available = maxChroma(lightness, hue);
    const ratio = available ? Math.min(1, chroma / available) : 0;
    if (ratio < MIN_CHROMA_RATIO) continue;
    const outputLightness = LIGHTNESS + .20 * Math.max(0, 1 - Math.abs(hue - 110) / 55);
    const outputChroma = Math.min(MAX_CHROMA, ratio * maxChroma(outputLightness, hue));
    return `oklch(${(outputLightness * 100).toFixed(0)}% ${outputChroma.toFixed(3)} ${hue.toFixed(1)})`;
  }
  return null;
}

/**
 * The accent of one decoded region of RGBA pixels, or null when it reads as
 * grey. The subject sits in the middle of the frame, so a centre slice holds
 * the colour the card should echo; edges are usually background wash or spill
 * from a neighbouring scene and read as the "key" colour only by weight of
 * numbers. Skin is discarded outright in that pass, so a slice of mostly bare
 * subject leaves only a thin scatter behind - hence the share the winner must
 * carry before it is trusted.
 */
export function accentFromImageData(data, width, height) {
  const centreWidth = Math.max(1, Math.round(width * CENTRE_FRACTION));
  const left = Math.floor((width - centreWidth) / 2);
  const centre = new Uint8ClampedArray(centreWidth * height * 4);
  for (let y = 0; y < height; y++) {
    centre.set(data.slice((y * width + left) * 4, (y * width + left + centreWidth) * 4),
      y * centreWidth * 4);
  }
  const [centreColours] = binsOf(centre);
  const centreFloor = CENTRE_MIN_SHARE * height * centreWidth;
  const accent = accentFromBins(centreColours, centreFloor, true);
  if (accent) return accent;
  const [colours, skin] = binsOf(data);
  // A yellow subject can lend the card another colour from the surrounding
  // image. Keep a minimum share here too so a stray pixel cannot replace it.
  return accentFromBins(colours, CENTRE_MIN_SHARE * width * height, true)
    || accentFromBins(centreColours, centreFloor)
    || accentFromBins(colours) || accentFromBins(skin);
}

/**
 * The accent of one loaded image, or null when it reads as grey or its pixels
 * are not ours to read - a picture from another origin served without CORS
 * taints the canvas, and the caller keeps whatever default it had. The sample
 * is drawn at `width`x`height`, so a square portrait passes a square size
 * rather than being squeezed into a thumbnail's 16:9.
 */
export function accentFromImage(image, width = 32, height = 18) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    context.drawImage(image, 0, 0, width, height);
    return accentFromImageData(context.getImageData(0, 0, width, height).data, width, height);
  } catch (_) {
    return null;
  }
}

/** Runs `apply` once the image has pixels, now or when it finishes loading. */
export function whenImageLoaded(image, apply) {
  if (image.complete && image.naturalWidth) apply();
  else image.addEventListener('load', apply, {once: true});
}
