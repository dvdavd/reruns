export const ASPECT_MORPH_MS = 300;
const ASPECT_MORPH_EASING = 'cubic-bezier(.22,.8,.25,1)';

export function createPlayerTransitions({
  page, home, getAudioBar,
}) {
  let transitionToken = 0;
  let transitionImage = null;
  // A shape correction landing mid-zoom waits for the thumbnail; see
  // settleAspect. It matches the .archive-watch-stage transition in the
  // stylesheet, so the frame and the thumbnail over it move as one.
  // The zoom's thumbnail stays over the player until the video's opening frame
  // is ready, but no longer than this: a codec that stalls without an error
  // would otherwise leave it there for good.
  const ZOOM_HOLD_LIMIT_MS = 4000;
  let aspectFlight = false;
  let aspectPending = '';
  let sourceSpot = null;
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

  // The stage eases its width and margins so a corrected shape glides into
  // place, but a window being dragged changes them every frame: each frame
  // restarted the ease, so the picture trailed the layout across the chat
  // beside it and kept the compositor busy. While the window is resizing the
  // frame follows it directly (see .is-window-resizing in the stylesheets).
  let resizeSettle = 0;
  window.addEventListener('resize', () => {
    page.classList.add('is-window-resizing');
    clearTimeout(resizeSettle);
    resizeSettle = setTimeout(() => page.classList.remove('is-window-resizing'), 200);
  });
  const cardOverlays = card => card ? [
    ...card.querySelectorAll(
      '.thumbnail-frame > :not(.thumbnail-image), .thumbnail-area > :not(.thumbnail-button)',
    ),
  ] : [];

  // The same video can sit in more than one shelf — the favourites row and the
  // main grid both hold it — so take the copy the viewer can actually see.
  // Picking the first match zoomed to or from a card scrolled off the top, and
  // onScreen then cancelled the animation entirely.
  // A playlist card is one card standing for a whole playlist, so its own id
  // is the playlist's; the video it is currently showing is on data-part-id.
  // When both copies are on screen, "the one you can see" is still ambiguous,
  // and taking the first sent the return zoom to the favourites row's copy
  // rather than the grid card that was clicked. So the zoom in records where
  // its card sat in the document, and the way back prefers the visible copy
  // nearest that spot. A position rather than the node, because showing the
  // watch page re-renders the gallery and the node is gone by the time we return.
  const cardFor = (id, near = null) => {
    const cards = [...home.querySelectorAll('.video-card[data-id], .video-card[data-part-id]')]
      .filter(card => card.dataset.id === id || card.dataset.partId === id);
    const visible = cards
      .map(card => ({card, rect: card.querySelector('.thumbnail-image')?.getBoundingClientRect()}))
      .filter(({rect}) => onScreen(rect));
    if (near?.id === id && visible.length > 1) {
      const distance = ({rect}) => Math.hypot(
        rect.left + window.scrollX - near.left, rect.top + window.scrollY - near.top,
      );
      return visible.reduce((best, entry) => (distance(entry) < distance(best) ? entry : best)).card;
    }
    return visible[0]?.card || cards[0];
  };

  /**
   * The corners a card's thumbnail shows. The rounding sits on whichever
   * clipping ancestor the card puts it on (today the thumbnail button, rounded
   * at the top only), so take the first one that has any.
   */
  function thumbnailRadius(image) {
    for (let node = image; node && !node.classList.contains('video-card'); node = node.parentElement) {
      const radius = getComputedStyle(node).borderRadius;
      if (radius.split(' ').some(part => parseFloat(part) > 0)) return radius;
    }
    return '8px';
  }

  /**
   * Whether a card's thumbnail can be seen: some of it inside the window and
   * below the sticky topbar. A zoom to or from one that cannot would fly in
   * from nowhere, so those get no transition at all.
   */
  function onScreen(rect) {
    if (!rect?.width || !rect?.height) return false;
    const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
    return rect.bottom > top && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  }

  function transitionSource(event, item) {
    // A card click hands us the card; browser Forward has no event, so fall
    // back to the card still sitting in the gallery behind us. Without it the
    // history navigation would get no zoom at all.
    const card = event?.currentTarget?.closest('.video-card') || cardFor(item.id, sourceSpot);
    const image = card?.querySelector?.('.thumbnail-image');
    const rect = image?.getBoundingClientRect();
    // No source means no transition: the player is simply there.
    if (!onScreen(rect)) return {src: ''};
    sourceSpot = {id: item.id, left: rect.left + window.scrollX, top: rect.top + window.scrollY};
    return {
      src: image?.currentSrc || image?.src || item.thumbnail?.url || '',
      rect,
      radius: thumbnailRadius(image),
    };
  }

  const stageNode = () => page.querySelector('.archive-watch-stage');

  /**
   * The stage's rect without the strip a phone gives the control bar under the
   * picture (it is the stage's bottom padding). The zoom to and from a card
   * is of the picture alone; measured whole, the thumbnail landed on, and
   * left from, a frame taller than the video.
   */
  const pictureRect = () => {
    const stage = stageNode();
    const rect = stage.getBoundingClientRect();
    const strip = parseFloat(getComputedStyle(stage).paddingBottom) || 0;
    return new DOMRect(rect.left, rect.top, rect.width, Math.max(0, rect.height - strip));
  };

  // Animate in document coordinates so scrolling moves the thumbnail and
  // player together, including while the thumbnail fades away.
  const documentRect = rect => ({
    left: rect.left + window.scrollX, top: rect.top + window.scrollY,
    width: rect.width, height: rect.height,
  });

  /** Every length in a computed border-radius, multiplied by `factor`. */
  const scaleRadius = (radius, factor) => String(radius)
    .replace(/(-?[\d.]+)px/g, (_, value) => `${parseFloat(value) * factor}px`);

  /**
   * The smallest rect of `aspect` (width over height) that covers `rect`,
   * centred on it. The zoom flies the thumbnail at the card's shape whatever
   * the video's is, so over a narrower stage this is where it lands: a 4:3
   * or vertical video's height, with the sides hanging over.
   */
  const coverShape = (rect, aspect) => {
    const width = Math.max(rect.width, rect.height * aspect);
    const height = width / aspect;
    return {
      left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2,
      width, height,
    };
  };

  const sameShape = (a, b) => Math.abs((a.width / a.height) / (b.width / b.height) - 1) < 0.01;

  /**
   * Where a thumbnail of `aspect` sits over the stage. Covering a stage
   * narrower than it hangs the sides over and fades them (see cropCopy), but
   * covering a wider one made it as tall as a 16:9 player that wide, which
   * filled the page; a wide video takes the stage's own rect instead, and
   * the thumbnail changes shape on the way (see flyBetween).
   */
  const landingRect = (stage, aspect) => (stage.width / stage.height > aspect * 1.01
    ? stage : coverShape(stage, aspect));

  /**
   * A copy of `image` (sitting at `shown`) cut down to the part over
   * `stage`, laid over it. With the copy in place the whole thumbnail can
   * fade, so the overhang fades away and the picture over the stage stays.
   * The cut is in percentages of the image, so it flies with it at any size.
   */
  function cropCopy(image, shown, stage, radius) {
    const copy = image.cloneNode();
    const pct = (part, whole) => `${(part / whole) * 100}%`;
    const radii = String(radius).split('/')[0].trim().split(/\s+/).map(parseFloat);
    const corners = [0, 1, 2, 3].map(n => radii[n] ?? radii[n > 1 ? n - 2 : 0] ?? 0);
    copy.style.borderRadius = '0';
    copy.style.clipPath = `inset(${pct(stage.top - shown.top, shown.height)} `
      + `${pct(shown.left + shown.width - stage.left - stage.width, shown.width)} `
      + `${pct(shown.top + shown.height - stage.top - stage.height, shown.height)} `
      + `${pct(stage.left - shown.left, shown.width)} round `
      + `${corners.map(r => pct(r, shown.width)).join(' ')} / ${corners.map(r => pct(r, shown.height)).join(' ')})`;
    image.after(copy);
    return copy;
  }

  /**
   * Flies `image` between two rects of the same shape and resolves when it
   * lands, left sitting at `to` in plain layout.
   *
   * Opening a video is the page's busiest moment: the watch page renders,
   * the video starts, details and comments arrive, and the glow wakes up.
   * Animating left/top/width/height ran on the main thread, so each of those
   * tasks froze the thumbnail mid-flight. A transform runs on the compositor
   * and keeps going through them. The scale is uniform, which is why the
   * thumbnail keeps the card's shape all the way, and a narrower video is
   * reached by fading the overhang instead (see cropCopy).
   */
  async function flyRect(image, from, fromRadius, to, toRadius, timing) {
    const launch = prepareFlight(image, from, fromRadius, to, toRadius);
    await frame().then(frame);
    return launch(timing);
  }

  /**
   * Puts `image` at the start of a flight from `from` to `to`, and returns
   * the function that sets it off.
   *
   * The image is laid out at the size it lands at and scaled down to where
   * it starts, so the first frame of a flight is a much bigger image than
   * the one on the card. Starting the clock in the same frame meant the
   * browser could spend the opening frames decoding and drawing it at that
   * size - Firefox draws images asynchronously - and the flight was already
   * part-way when it first showed. Placed first, it is drawn while it sits
   * where the card's picture is, and looks the same.
   */
  function prepareFlight(image, from, fromRadius, to, toRadius) {
    const scale = from.width / to.width;
    const start = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})`;
    // The corners are scaled with the picture, so they start out at the
    // card's rounding divided by the scale.
    const startRadius = scaleRadius(fromRadius, 1 / scale);
    Object.assign(image.style, {
      left: `${to.left}px`, top: `${to.top}px`,
      width: `${to.width}px`, height: `${to.height}px`,
      transformOrigin: '0 0', transform: start, borderRadius: startRadius, willChange: 'transform',
    });
    return async timing => {
      // The radius is a separate animation, since it cannot run on the
      // compositor and would hold the transform back with it; if the main
      // thread is busy only the corners lag.
      image.animate([{borderRadius: startRadius}, {borderRadius: toRadius}], {...timing, fill: 'both'});
      await image.animate([{transform: start}, {transform: 'none'}], {...timing, fill: 'both'})
        .finished.catch(() => {});
      for (const running of image.getAnimations()) running.cancel();
      for (const property of ['transform', 'transform-origin', 'will-change']) image.style.removeProperty(property);
      image.style.borderRadius = toRadius;
    };
  }

  /**
   * Flies between rects of different shapes by animating the rect itself,
   * which the main thread has to draw, so this is kept to wide videos.
   */
  async function flyLayout(image, from, fromRadius, to, toRadius, timing) {
    const place = (rect, radius) => ({
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: radius,
    });
    Object.assign(image.style, place(to, toRadius));
    await image.animate([place(from, fromRadius), place(to, toRadius)], {...timing, fill: 'both'})
      .finished.catch(() => {});
    for (const running of image.getAnimations()) running.cancel();
  }

  const flyBetween = (image, from, fromRadius, to, toRadius, timing) => (sameShape(from, to)
    ? flyRect : flyLayout)(image, from, fromRadius, to, toRadius, timing);

  async function transitionThumbnail(source, frameReady) {
    if (!source.src) return;
    const token = ++transitionToken;
    transitionImage?.remove();
    let image = document.createElement('img');
    transitionImage = image;
    image.className = 'watch-thumbnail-transition watch-thumbnail-transition-enter';
    image.src = source.src;
    image.alt = '';
    const initial = documentRect(source.rect || pictureRect());
    Object.assign(image.style, {
      left: `${initial.left}px`, top: `${initial.top}px`,
      width: `${initial.width}px`, height: `${initial.height}px`,
    });
    document.body.append(image);
    // Decoded before it flies, so the first frames are not spent waiting on
    // the picture. It is the card's own image, so this is normally at once.
    await Promise.all([image.decode().catch(() => {}), frame().then(frame)]);
    if (token !== transitionToken) return image.remove();
    const shape = initial.width / initial.height;
    const target = landingRect(documentRect(pictureRect()), shape);
    const targetRadius = getComputedStyle(stageNode()).borderRadius;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (source.rect && !reduced) {
      await flyBetween(image, initial, source.radius, target, targetRadius,
        {duration: 360, easing: 'cubic-bezier(.22,.8,.25,1)'});
    } else {
      Object.assign(image.style, {
        left: `${target.left}px`, top: `${target.top}px`,
        width: `${target.width}px`, height: `${target.height}px`, borderRadius: targetRadius,
      });
    }
    if (token !== transitionToken) return image.remove();
    const landed = await settleAspect(image, target, targetRadius, shape);
    if (token !== transitionToken) return image.remove();
    const fade = {duration: reduced ? 100 : 220, easing: 'ease'};
    // A video of another shape: the overhang fades away, leaving a copy cut
    // to the stage that carries on as the thumbnail below.
    const stage = documentRect(pictureRect());
    if (!sameShape(landed, stage)) {
      const whole = image;
      image = cropCopy(whole, landed, stage, targetRadius);
      transitionImage = image;
      const gone = () => whole.remove();
      whole.animate([{opacity: 1}, {opacity: 0}], {...fade, fill: 'forwards'}).finished.then(gone, gone);
    }
    // The stage is now wholly under the thumbnail, so it is revealed and the
    // thumbnail's fade is the only visible handoff.
    page.classList.remove('is-thumbnail-transitioning');
    // A video that resumes shows its first frame before seeking to where the
    // viewer had got to, so fading on landing let the start of the video show
    // through for a moment. Hold until the frame it opens on is there.
    await Promise.race([frameReady, new Promise(resolve => setTimeout(resolve, ZOOM_HOLD_LIMIT_MS))]);
    if (token !== transitionToken) return image.remove();
    await image.animate([{opacity: 1}, {opacity: 0}], {...fade, fill: 'forwards'}).finished.catch(() => {});
    image.remove();
    if (transitionImage === image) {
      transitionImage = null;
      page.classList.remove('is-zooming');
    }
  }

  async function transitionBackThumbnail(item, initial, initialRadius = getComputedStyle(stageNode()).borderRadius) {
    const src = item?.thumbnail?.url || '';
    if (!src || !initial.width || !initial.height) return;
    const token = ++transitionToken;
    transitionImage?.remove();
    const image = document.createElement('img');
    transitionImage = image;
    // Absolute, like the zoom in, and flown in document coordinates: a fixed
    // image aimed at a viewport rect stayed put when the viewer scrolled the
    // gallery mid-flight, and landed beside the card instead of on it.
    image.className = 'watch-thumbnail-transition watch-thumbnail-transition-enter';
    image.src = src;
    image.alt = '';
    // The thumbnail is the card's shape, so it leaves from that shape over
    // the picture; flying a different shape would stretch it.
    const start = landingRect(documentRect(initial), 16 / 9);
    Object.assign(image.style, {
      left: `${start.left}px`, top: `${start.top}px`,
      width: `${start.width}px`, height: `${start.height}px`,
    });
    document.body.append(image);
    // A video of another shape leaves as itself: a copy cut to the picture
    // is what shows, and the rest of the thumbnail fades in as it flies.
    const crop = sameShape(start, initial) ? null : cropCopy(image, start, documentRect(initial), initialRadius);
    if (crop) image.style.opacity = '0';
    const removeAll = () => { crop?.remove(); image.remove(); };
    const initialCard = cardFor(item.id, sourceSpot);
    let cardImage = initialCard?.querySelector('.thumbnail-image');
    let overlays = cardOverlays(initialCard);
    if (cardImage) cardImage.style.visibility = 'hidden';
    for (const overlay of overlays) overlay.style.opacity = '0';
    await Promise.all([image.decode().catch(() => {}), frame().then(frame)]);
    if (token !== transitionToken) {
      cardImage?.style.removeProperty('visibility');
      for (const overlay of overlays) overlay.style.removeProperty('opacity');
      return removeAll();
    }
    // Re-query rather than trusting the node captured above: showing the watch
    // page re-renders the gallery, so that node is detached by now and would
    // measure zero, collapsing the zoom into a bare fade.
    const card = cardFor(item.id, sourceSpot);
    if (card !== initialCard) {
      cardImage?.style.removeProperty('visibility');
      for (const overlay of overlays) overlay.style.removeProperty('opacity');
      cardImage = card?.querySelector('.thumbnail-image');
    }
    overlays = cardOverlays(card);
    cardImage ||= card?.querySelector('.thumbnail-image');
    if (cardImage) cardImage.style.visibility = 'hidden';
    for (const overlay of overlays) overlay.style.opacity = '0';
    const targetView = cardImage?.getBoundingClientRect();
    const target = targetView && documentRect(targetView);
    const from = target ? landingRect(documentRect(initial), target.width / target.height) : start;
    const targetRadius = thumbnailRadius(cardImage);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const visible = onScreen(targetView);
    if (visible && !reduced) {
      const timing = {duration: 260, easing: 'cubic-bezier(.22,.8,.25,1)'};
      if (crop) {
        // The copy flies with the thumbnail and its sides fade in over the
        // first part of the flight; once they have, the copy is redundant.
        // Both are placed before either sets off, so they leave together.
        const launch = prepareFlight(image, from, initialRadius, target, targetRadius);
        const launchCrop = prepareFlight(crop, from, '0px', target, '0px');
        await frame().then(frame);
        launchCrop(timing);
        image.animate([{opacity: 0}, {opacity: 1}], {duration: 110, easing: 'ease-out'})
          .finished.then(() => { image.style.removeProperty('opacity'); crop.remove(); }, () => {});
        await launch(timing);
      } else {
        await flyBetween(image, from, initialRadius, target, targetRadius, timing);
      }
    } else if (visible) {
      await Promise.all([crop || image].map(node => node.animate([{opacity: 1}, {opacity: 0}], {
        duration: reduced ? 100 : 180, easing: 'ease', fill: 'forwards',
      }).finished.catch(() => {})));
    }
    cardImage?.style.removeProperty('visibility');
    removeAll();
    if (transitionImage === image) transitionImage = null;
    await Promise.all(overlays.map(overlay => overlay.animate([{opacity: 0}, {opacity: 1}], {
      duration: reduced ? 60 : 110, easing: 'ease-out', fill: 'forwards',
    }).finished.catch(() => {})));
    for (const overlay of overlays) overlay.style.removeProperty('opacity');
  }

  /**
   * The shape of the stage, from the listing's own dimensions. The decoded
   * frame confirms it later: only the video element knows about a rotation
   * flag, or about a file whose header lied.
   */
  function aspectOf(item) {
    const [width, height] = String(item?.parts?.[0]?.resolution || '').split('x').map(Number);
    return width > 0 && height > 0 ? `${width} / ${height}` : '';
  }

  function applyAspect(value) {
    if (value) page.style.setProperty('--watch-aspect', value);
    else page.style.removeProperty('--watch-aspect');
    // A video taller than it is wide is held to the window's height on a
    // phone, so the stylesheet floats its controls over the picture rather
    // than spending height on a strip below it (see popups.css).
    const [width, height] = String(value || '').split('/').map(Number);
    page.toggleAttribute('data-tall-video', height > width);
  }

  /** The stage moves between shapes rather than snapping between them, so this
   *  is also how a correction from the decoded frame arrives. A zoom from a
   *  card is the exception: it is already flying the thumbnail to a measured
   *  rect, so a correction waits for it to land - `settleAspect` applies it. */
  function setAspect(value) {
    if (aspectFlight) aspectPending = value;
    else applyAspect(value);
  }

  /**
   * A correction that arrived while the thumbnail was in flight, applied now
   * that it has landed: the stage takes the new shape and the thumbnail
   * moves to its card-shaped fit inside it. Resolves with where it ends up.
   */
  async function settleAspect(image, from, radius, shape) {
    aspectFlight = false;
    if (!aspectPending || !from) return from;
    applyAspect(aspectPending);
    aspectPending = '';
    await frame();
    const to = landingRect(documentRect(pictureRect()), shape);
    if (Math.abs(to.width - from.width) < 1 && Math.abs(to.height - from.height) < 1) return from;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      Object.assign(image.style, {
        left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`,
      });
    } else {
      await flyBetween(image, from, radius, to, radius, {duration: ASPECT_MORPH_MS, easing: ASPECT_MORPH_EASING});
    }
    return to;
  }

  /**
   * Carries the stage from where it was to where it now is, so shrinking to
   * the corner and coming back read as one object moving rather than a cut.
   * The page rearranges first and the stage is then pulled back to its old
   * rect, which is why it works from the two measured rects and not from any
   * knowledge of the layout. Lifted above the rest of the page meanwhile,
   * since the later siblings are positioned and would paint over it.
   */
  function flyStage(from) {
    const stage = stageNode();
    const to = stage.getBoundingClientRect();
    if (!from?.width || !to.width || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    stage.style.zIndex = '5';
    const flight = stage.animate([
      {transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) `
        + `scale(${from.width / to.width}, ${from.height / to.height})`},
      {transformOrigin: '0 0', transform: 'none'},
    ], {duration: ASPECT_MORPH_MS, easing: ASPECT_MORPH_EASING});
    const done = () => { stage.style.zIndex = ''; };
    flight.finished.then(done, done);
  }

  /**
   * Brings the bar down to the foot of the page, from where the watch page
   * it replaces was. A video shrinking to the corner has a picture to carry
   * down (see flyStage); the bar's picture is a different shape, so the bar
   * comes in as itself, and works for sound with no picture at all. The
   * element is the watch page itself, already reduced to the bar by its
   * classes, so it is the one thing that moves. It keeps the flight's
   * duration and easing so that, with a picture flying in (see flyCover),
   * the two land together.
   */
  function dropBar() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    page.animate([
      {transform: 'translateY(-30vh)', opacity: 0},
      {transform: 'none', opacity: 1},
    ], {duration: ASPECT_MORPH_MS, easing: ASPECT_MORPH_EASING});
  }

  /**
   * Flies a loose copy of a picture from one rect to another, its rounding
   * moving with it and the crop held throughout by object-fit as the stage's
   * own is. A loose image rather than either end itself, since one of them is
   * on a page or bar that is still arriving or leaving. Says whether it flew,
   * for a picture that is missing or a viewer who asks for stillness has
   * nothing to carry; `settled` runs once it has landed or been abandoned.
   */
  function flyImage(src, from, fromRadius, to, toRadius, settled) {
    if (!src || !from?.width || !to?.width
      || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const image = document.createElement('img');
    image.className = 'watch-thumbnail-transition';
    image.src = src;
    image.alt = '';
    const place = (rect, radius) => ({
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: radius,
    });
    Object.assign(image.style, place(from, fromRadius));
    document.body.append(image);
    const flight = image.animate(
      [place(from, fromRadius), place(to, toRadius)],
      {duration: ASPECT_MORPH_MS, easing: ASPECT_MORPH_EASING, fill: 'forwards'},
    );
    const done = () => { image.remove(); settled(); };
    flight.finished.then(done, done);
    return true;
  }

  /**
   * Carries the picture from where it was on the page to the bar's round
   * cover. It is aimed at where the cover will end up, measured before the
   * bar moves, and the real one stays hidden until the copy lands on it.
   */
  function flyCover(from, fromRadius, item) {
    const slot = getAudioBar().querySelector('.archive-audio-cover');
    const to = slot?.getBoundingClientRect();
    if (!to?.width) return false;
    slot.style.visibility = 'hidden';
    const flew = flyImage(item?.thumbnail?.url, from, fromRadius, to, `${to.height / 2}px`,
      () => slot.style.removeProperty('visibility'));
    if (!flew) slot.style.removeProperty('visibility');
    return flew;
  }

  /** The bar's arrival, with whatever picture there is to bring with it. */
  function enterBar(item, from, fromRadius) {
    flyCover(from, fromRadius, item);
    dropBar();
  }

  /**
   * A stand-in for the bar to leave by. The bar is the watch page itself, so
   * when the page comes back it stops being a bar at once; this copy, made
   * while it still is one and dressed by the same classes, stays behind to
   * lift away, the reverse of dropBar. Its cover is hidden when the picture
   * has its own flight, and left in when it does not. Going to the corner
   * window there is nowhere for a lift to head, and it only shows as a bar
   * drifting past the window's edge, so that leaves with a short fade where
   * it stands.
   */
  function leaveBar({lift = true, flying = true} = {}) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ghost = document.createElement('div');
    ghost.className = page.className;
    ghost.inert = true;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.pointerEvents = 'none';
    const copy = getAudioBar().cloneNode(true);
    for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
    if (flying) copy.querySelector('.archive-audio-cover').style.visibility = 'hidden';
    ghost.append(copy);
    document.body.append(ghost);
    const leaving = ghost.animate([
      {transform: 'none', opacity: 1},
      {transform: lift ? 'translateY(-30vh)' : 'none', opacity: 0},
    ], {
      duration: lift ? ASPECT_MORPH_MS : ASPECT_MORPH_MS / 2,
      easing: ASPECT_MORPH_EASING, fill: 'forwards',
    });
    const done = () => ghost.remove();
    leaving.finished.then(done, done);
  }

  /**
   * The picture's way out of the bar, to the stage now showing in its place
   * - the watch page or the corner window. The stage waits out the flight,
   * so the picture lands on it rather than being under a copy of itself from
   * the start. `coverRect` is the bar's cover, taken before it went.
   */
  function flyFromBar(item, coverRect) {
    const stage = stageNode();
    stage.style.visibility = 'hidden';
    const flew = flyImage(item.thumbnail?.url, coverRect, `${coverRect.height / 2}px`,
      pictureRect(), getComputedStyle(stage).borderRadius, () => stage.style.removeProperty('visibility'));
    if (!flew) stage.style.removeProperty('visibility');
  }

  return {
    stageNode, pictureRect, transitionSource, transitionThumbnail, transitionBackThumbnail,
    aspectOf, applyAspect, setAspect, flyStage, enterBar, leaveBar, flyFromBar,
    begin(source) { aspectFlight = Boolean(source.src); aspectPending = ''; },
    cancel() {
      transitionToken += 1;
      transitionImage?.remove();
      transitionImage = null;
    },
  };
}
