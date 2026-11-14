"""Smoke tests that drive the real page in a browser.

The failures these catch are the silent ones: a wrong sprite URL or a setting
that is read and then ignored raises no console error and fails no request,
and the logic sits inside closures the node tests cannot reach.

They are skipped, not failed, where Playwright, a browser or ffmpeg with VP8
and Opus is missing, so CI's plain 'docker' runner carries on without them.
Run them where a browser is installed: `python3 -m pip install -e '.[browser]'`
then `python3 -m pytest tests/test_browser.py`. Set RERUNS_TEST_BROWSER to a
Chromium executable to use one other than Playwright's own.
"""
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover - depends on the machine
    sync_playwright = None

ROOT = Path(__file__).resolve().parent.parent
BACKGROUND_KEY = "ytdlp-background-play-v1"
AUTOPLAY_KEY = "ytdlp-autoplay-v1"
FROM_START_KEY = "ytdlp-autoplay-from-start-v1"


def chromium_executable():
    """Playwright's own browser when its version matches, else the newest
    Chromium in its cache: a browser installed by an older Playwright still
    drives fine, and an exact-version download is not worth a failed run."""
    configured = os.environ.get("RERUNS_TEST_BROWSER")
    if configured:
        return configured
    cache = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
                 or Path.home() / ".cache" / "ms-playwright")
    found = sorted(glob.glob(str(cache / "chromium-*" / "chrome-linux*" / "chrome")))
    return found[-1] if found else None


def ffmpeg_makes_clips():
    if not shutil.which("ffmpeg"):
        return False
    encoders = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                              capture_output=True, text=True).stdout
    return "libvpx " in encoders and "libopus" in encoders


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def make_clip(folder, name, title, *, video):
    """A clip with its sidecar. VP8 and Opus because the browsers Playwright
    ships have no H.264 or AAC; long enough to still be playing when the
    test leaves the page."""
    suffix = "webm" if video else "opus"
    command = ["ffmpeg", "-nostdin", "-v", "error", "-y",
               "-f", "lavfi", "-i", "sine=frequency=440:duration=30"]
    if video:
        command += ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=30",
                    "-c:v", "libvpx", "-b:v", "50k"]
    command += ["-c:a", "libopus", str(folder / f"{name}.{suffix}")]
    subprocess.run(command, check=True)
    (folder / f"{name}.info.json").write_text(json.dumps({
        "id": name, "title": title, "duration": 30,
        "extractor": "youtube", "extractor_key": "Youtube",
        "webpage_url": f"https://www.youtube.com/watch?v={name}",
        "channel": "Smoke", "channel_id": "UCsmoke", "uploader": "Smoke",
        "upload_date": "20240101", "ext": suffix,
        "vcodec": "vp8" if video else "none", "acodec": "opus",
        "width": 160 if video else None, "height": 120 if video else None,
    }), encoding="utf-8")


@unittest.skipUnless(sync_playwright, "needs the playwright package")
@unittest.skipUnless(chromium_executable(), "needs a Chromium for playwright")
@unittest.skipUnless(ffmpeg_makes_clips(), "needs ffmpeg with libvpx and libopus")
class _BrowserCase(unittest.TestCase):
    """A server over an archive the subclass fills, and a browser to drive it."""
    @classmethod
    def fill_archive(cls, archive):
        raise NotImplementedError

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        base = Path(cls.temp.name)
        archive = base / "archive"
        archive.mkdir()
        cls.fill_archive(archive)
        port = free_port()
        cls.url = f"http://127.0.0.1:{port}"
        cls.log = open(base / "server.log", "w")
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "reruns", str(archive), "--port", str(port),
             "--no-auth", "--config", str(base / "config"),
             "--cache", str(base / "cache"),
             "--channel-cache", str(base / "channels"),
             "--thumbnail-cache", str(base / "thumbnails"),
             "--browse-cache", str(base / "browse"),
             "--sponsorblock-cache", str(base / "sponsorblock"),
             "--probe-cache", str(base / "probes"),
             "--sidecar-cache", str(base / "sidecars.json")],
            cwd=ROOT, stdout=cls.log, stderr=subprocess.STDOUT)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=chromium_executable(),
            args=["--autoplay-policy=no-user-gesture-required"])
        deadline = time.monotonic() + 20
        while True:
            try:
                urllib.request.urlopen(cls.url, timeout=1).close()
                break
            except OSError:
                if cls.server.poll() is not None or time.monotonic() > deadline:
                    cls.tearDownClass()
                    raise RuntimeError(Path(cls.log.name).read_text()) from None
                time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        for step in (lambda: cls.browser.close(), lambda: cls.playwright.stop()):
            try:
                step()
            except Exception:
                pass
        server = getattr(cls, "server", None)
        if server:
            server.terminate()
            server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    def open_page(self, background=None, autoplay=None, stored=()):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        for key, value in ((BACKGROUND_KEY, background), (AUTOPLAY_KEY, autoplay), *stored):
            if value:
                context.add_init_script(f"localStorage.setItem('{key}', '{value}')")
        page = context.new_page()
        # /api/preferences is not served without accounts, so its 404 is
        # expected here; anything else failing is not.
        self.failures = []
        page.on("response", lambda r: self.failures.append(f"{r.status} {r.url}")
                if r.status >= 400 and "/api/preferences" not in r.url else None)
        page.on("pageerror", lambda error: self.failures.append(str(error)))
        page.goto(self.url + "/?videos")
        page.wait_for_selector(".video-card")
        return page


class BrowserSmokeTests(_BrowserCase):
    @classmethod
    def fill_archive(cls, archive):
        make_clip(archive, "smokevideo", "Smoke Video", video=True)
        make_clip(archive, "smokesong", "Smoke Song", video=False)

    def test_library_lists_the_clips_without_failed_requests(self):
        page = self.open_page()
        titles = page.locator(".video-card").all_inner_texts()
        self.assertTrue(any("Smoke Video" in text for text in titles), titles)
        self.assertTrue(any("Smoke Song" in text for text in titles), titles)
        self.assertEqual(self.failures, [])

    def test_icons_resolve_from_the_sprite(self):
        page = self.open_page()
        broken = page.evaluate("""async () => {
            const missing = [];
            for (const use of document.querySelectorAll('use')) {
                const [file, id] = use.getAttribute('href').split('#');
                const text = await (await fetch(file)).text();
                if (!text.includes(`id="${id}"`)) missing.push(`${file}#${id}`);
            }
            return missing;
        }""")
        self.assertEqual(broken, [])
        self.assertGreater(page.locator("use").count(), 0)

    def play(self, page, title):
        page.click(f'.thumbnail-button[aria-label="View details for {title}"]')
        page.wait_for_selector("#archive-player:not([hidden])")
        page.wait_for_function(
            """() => { const v = document.querySelector('#archive-player video');
                      return v && !v.paused && v.currentTime > 0.3; }""",
            timeout=10000)

    def left_in_background(self, page):
        page.go_back()
        page.wait_for_selector(".video-card")
        # close() settles on the next frames, not synchronously.
        page.wait_for_timeout(800)
        return page.evaluate("""() => {
            const player = document.querySelector('#archive-player');
            return player.classList.contains('is-mini') && !player.hidden;
        }""")

    def test_player_opens_and_plays(self):
        page = self.open_page()
        self.play(page, "Smoke Video")
        self.assertIn("watch=", page.url)
        self.assertEqual(self.failures, [])

    def test_background_play_follows_its_setting(self):
        # The setting decides what leaving the page keeps playing: On keeps
        # anything, Automatic only what is listened to, Off nothing.
        expected = {
            ("auto", "Smoke Video"): True, ("auto", "Smoke Song"): True,
            ("audio", "Smoke Video"): False, ("audio", "Smoke Song"): True,
            ("off", "Smoke Video"): False, ("off", "Smoke Song"): False,
        }
        for (mode, title), keeps in expected.items():
            with self.subTest(mode=mode, item=title):
                page = self.open_page(background=mode)
                self.play(page, title)
                self.assertEqual(self.left_in_background(page), keeps)

    def test_failed_download_has_a_working_retry_control(self):
        page = self.open_page()
        page.evaluate("""async () => {
            const {render} = await import('media-ui');
            const {downloadRow} = await import('/download-row.js');
            const {flattenDownloads} = await import('/download-model.js');
            const host = document.createElement('div');
            host.id = 'retry-preview';
            document.body.append(host);
            const [row] = flattenDownloads([{id: 'failed-job', state: 'failed',
                kind: 'download', url: 'https://example.test/video', error: 'Offline'}]);
            render(downloadRow(row, {onAction: (id, action) => {
                window.retryAction = {id, action};
            }}), host);
        }""")
        button = page.locator('#retry-preview').get_by_role('button', name='Retry', exact=True)
        button.scroll_into_view_if_needed()
        button.click()
        self.assertEqual(page.evaluate('window.retryAction'),
                         {'id': 'failed-job', 'action': 'resume'})
        self.assertEqual(self.failures, [])

    def test_a_recording_in_a_batch_can_cancel_the_whole_batch(self):
        page = self.open_page()
        page.evaluate("""async () => {
            const {render} = await import('media-ui');
            const {downloadRow} = await import('/download-row.js');
            const {flattenDownloads} = await import('/download-model.js');
            const host = document.createElement('div');
            host.id = 'batch-preview';
            document.body.append(host);
            const item = (id, state, live = false) => ({id, title: id, state, live,
                files: [], error: '', transfers: []});
            const [row] = flattenDownloads([{id: 'batch-job', state: 'running',
                kind: 'download', url: 'https://example.test/streams',
                items: [item('live', 'running', true), item('next', 'queued')]}]);
            render(downloadRow(row, {onAction: (id, action) => {
                window.batchAction = {id, action};
            }}), host);
        }""")
        preview = page.locator('#batch-preview')
        self.assertEqual(preview.locator('.download-row-action').evaluate_all(
            'buttons => buttons.map(button => button.getAttribute("aria-label"))'),
            ['Stop and save recording', 'Cancel all 2', 'Discard recording'])
        button = preview.get_by_role('button', name='Cancel all 2', exact=True)
        # A glyph that resolved draws something; a wrong sprite href draws nothing.
        self.assertGreater(button.locator('svg').evaluate('svg => svg.getBBox().width'), 0)
        button.scroll_into_view_if_needed()
        button.click()
        self.assertEqual(page.evaluate('window.batchAction'),
                         {'id': 'batch-job', 'action': 'cancel'})
        self.assertEqual(self.failures, [])


class AutoplayTests(_BrowserCase):
    """Two videos from one channel, so each is the other's recommendation,
    and neither is in a playlist."""
    @classmethod
    def fill_archive(cls, archive):
        make_clip(archive, "autoone", "Smoke Lesson One", video=True)
        make_clip(archive, "autotwo", "Smoke Lesson Two", video=True)

    def watching(self, page):
        return page.evaluate("new URLSearchParams(location.search).get('watch')")

    def play_to_the_end(self, page, title):
        page.click(f'.thumbnail-button[aria-label="View details for {title}"]')
        page.wait_for_selector("#archive-player:not([hidden])")
        page.wait_for_function(
            """() => { const v = document.querySelector('#archive-player video');
                      return v && !v.paused && v.currentTime > 0.3; }""", timeout=10000)
        started = self.watching(page)
        page.evaluate("""() => { const v = document.querySelector('#archive-player video');
                                 v.currentTime = v.duration - 0.5; }""")
        return started

    def next_title(self, page):
        return page.evaluate("""() => {
            const side = document.querySelector('[data-part-side="1"]');
            return side.hidden ? null : side.querySelector('[data-part-title]').textContent;
        }""")

    def test_on_carries_on_to_a_recommended_video(self):
        page = self.open_page(autoplay="on")
        started = self.play_to_the_end(page, "Smoke Lesson One")
        self.assertEqual(self.next_title(page), "Smoke Lesson Two")
        page.wait_for_function(
            f"new URLSearchParams(location.search).get('watch') !== {json.dumps(started)}",
            timeout=10000)
        page.wait_for_function(
            """() => document.querySelector('[data-part-side="1"]').hidden""", timeout=5000)
        # The one just watched is not offered back, so the run stops here.
        self.assertIsNone(self.next_title(page))
        self.assertEqual(self.failures, [])

    def test_the_next_video_starts_from_the_top_when_asked(self):
        for from_start, lands_early in (("1", True), ("0", False)):
            with self.subTest(from_start=from_start):
                page = self.open_page(autoplay="on", stored=((FROM_START_KEY, from_start),))
                # Lesson Two was left off fifteen seconds in. Its key is the
                # item's id, which only the page knows, and leaving its watch
                # page saves a position of its own, so this is set after.
                page.click('.thumbnail-button[aria-label="View details for Smoke Lesson Two"]')
                page.wait_for_selector("#archive-player:not([hidden])")
                two = self.watching(page)
                page.goto(self.url + "/?videos")
                page.evaluate("""id => localStorage.setItem(
                    `reruns.playback:${JSON.stringify([id, 0])}`, '15')""", two)
                page.reload()
                page.wait_for_selector(".video-card")
                started = self.play_to_the_end(page, "Smoke Lesson One")
                page.wait_for_function(
                    f"new URLSearchParams(location.search).get('watch') !== {json.dumps(started)}",
                    timeout=10000)
                page.wait_for_function(
                    """() => { const v = document.querySelector('#archive-player video');
                              return v && !v.paused && v.currentTime > 0.3; }""", timeout=10000)
                at = page.evaluate("document.querySelector('#archive-player video').currentTime")
                self.assertEqual(at < 10, lands_early, at)
                self.assertEqual(self.failures, [])

    def test_playlist_only_stops_outside_a_playlist(self):
        # '1' was the old switch's on, which only ever knew playlists.
        for stored in ("playlist", "1"):
            with self.subTest(stored=stored):
                page = self.open_page(autoplay=stored)
                started = self.play_to_the_end(page, "Smoke Lesson One")
                self.assertIsNone(self.next_title(page))
                page.wait_for_function(
                    "document.querySelector('#archive-player video').ended", timeout=5000)
                page.wait_for_timeout(2000)
                self.assertEqual(self.watching(page), started)

    def test_the_menu_offers_three_choices(self):
        page = self.open_page(autoplay="1")
        page.click('.thumbnail-button[aria-label="View details for Smoke Lesson One"]')
        page.wait_for_selector("#archive-player:not([hidden])")
        page.evaluate("document.querySelector('[data-settings-open]').click()")
        page.wait_for_selector("#watch-settings-popup:popover-open")
        summary = page.locator("[data-autoplay-summary]")
        self.assertEqual(summary.inner_text(), "Playlist only")
        page.click('[data-settings-go="autoplay"]')
        options = page.locator("[data-autoplay-options] [role=radio]")
        self.assertEqual(options.all_inner_texts(), ["On", "Playlist only", "Off"])
        options.first.click()
        # The row's switch already says on, so plain On adds nothing to it.
        self.assertEqual(summary.inner_text(), "")
        self.assertIn("recommended", page.locator("[data-autoplay-note]").inner_text())
        self.assertEqual(page.evaluate(f"localStorage.getItem('{AUTOPLAY_KEY}')"), "on")
        # Choosing On offers the recommendation at once.
        self.assertEqual(self.next_title(page), "Smoke Lesson Two")
        toggle = page.locator("[data-autoplay-from-start]")
        self.assertTrue(toggle.is_visible())
        toggle.click()
        self.assertEqual(toggle.get_attribute("aria-checked"), "true")
        self.assertEqual(page.evaluate(f"localStorage.getItem('{FROM_START_KEY}')"), "1")
        # Nothing is autoplayed when it is off, so the switch goes with it.
        options.last.click()
        self.assertFalse(toggle.is_visible())
        self.assertEqual(self.failures, [])

    def test_the_menu_switch_turns_autoplay_back_on_as_it_was(self):
        page = self.open_page(autoplay="1")
        page.click('.thumbnail-button[aria-label="View details for Smoke Lesson One"]')
        page.wait_for_selector("#archive-player:not([hidden])")
        page.evaluate("document.querySelector('[data-settings-open]').click()")
        page.wait_for_selector("#watch-settings-popup:popover-open")
        switch = page.locator("[data-autoplay-switch]")
        summary = page.locator("[data-autoplay-summary]")
        self.assertEqual(switch.get_attribute("aria-checked"), "true")
        switch.click()
        self.assertEqual(switch.get_attribute("aria-checked"), "false")
        self.assertEqual(summary.inner_text(), "")
        self.assertEqual(page.evaluate(f"localStorage.getItem('{AUTOPLAY_KEY}')"), "off")
        # The menu stays on its main page; the chevron is what leads away.
        self.assertEqual(page.locator("#watch-settings-popup").get_attribute("data-page"), "")
        switch.click()
        self.assertEqual(summary.inner_text(), "Playlist only")
        self.assertEqual(page.evaluate(f"localStorage.getItem('{AUTOPLAY_KEY}')"), "playlist")
        self.assertEqual(self.failures, [])


class GalleryDeleteTests(_BrowserCase):
    """Enough videos for the gallery to draw them in more than one chunk."""
    @classmethod
    def fill_archive(cls, archive):
        make_clip(archive, "keep000", "Keep 0", video=True)
        info = json.loads((archive / "keep000.info.json").read_text())
        for index in range(1, 30):
            name = f"keep{index:03d}"
            # Copies, not links: the server will not delete a file that
            # another item shares.
            shutil.copyfile(archive / "keep000.webm", archive / f"{name}.webm")
            (archive / f"{name}.info.json").write_text(json.dumps(
                {**info, "id": name, "title": f"Keep {index}",
                 "webpage_url": f"https://www.youtube.com/watch?v={name}"}), encoding="utf-8")

    def test_deleting_a_video_keeps_the_other_cards(self):
        page = self.open_page()
        page.set_viewport_size({"width": 1400, "height": 900})
        page.wait_for_timeout(300)
        # The gallery used to throw every card away and make it again, once
        # for the list without the video and once for the rescan after, and
        # each new card's thumbnail was blank until it had decoded again.
        page.evaluate("""() => document.querySelectorAll('.video-card')
            .forEach(card => { card.keptThrough = true; })""")
        before = page.locator(".video-card").count()
        target = page.locator(".video-card").nth(3)
        doomed = target.get_attribute("data-id")
        target.hover()
        target.locator(".menu-trigger").click()
        page.get_by_role("menuitem", name="Delete").click()
        page.locator("dialog[open]").get_by_role("button", name="Delete").last.click()
        page.wait_for_function(
            "id => ![...document.querySelectorAll('.video-card')].some(card => card.dataset.id === id)",
            arg=doomed)
        page.wait_for_timeout(1000)
        remade = page.evaluate("""() => [...document.querySelectorAll('.video-card')]
            .filter(card => !card.keptThrough).map(card => card.dataset.id)""")
        # The deleted card leaves a gap that each chunk after it fills with the
        # first card of the next, so only those cards are new.
        self.assertLessEqual(len(remade), before // 12 + 1, remade)
        self.assertEqual(self.failures, [])


class GalleryScrollTests(_BrowserCase):
    """A library long enough that a jump to the bottom skips chunks, which
    stay at their estimated height until scrolling back up mounts them.

    The clips are all alike, and the gallery guesses a skipped chunk from the
    row height it has measured, so its guesses would be exact and nothing
    would ever need correcting. Cards drawn after the jump are made taller
    instead, as cards of another shape would be."""
    @classmethod
    def fill_archive(cls, archive):
        make_clip(archive, "scroll000", "Scroll 0", video=True)
        info = json.loads((archive / "scroll000.info.json").read_text())
        for index in range(1, 300):
            name = f"scroll{index:03d}"
            (archive / f"{name}.webm").symlink_to(archive / "scroll000.webm")
            (archive / f"{name}.info.json").write_text(json.dumps(
                {**info, "id": name, "title": f"Scroll {index}"}), encoding="utf-8")

    def test_scrolling_up_from_the_bottom_never_moves_the_other_way(self):
        page = self.open_page()
        page.set_viewport_size({"width": 1400, "height": 900})
        page.evaluate("""() => {
            window.corrections = 0;
            const scrollBy = window.scrollBy.bind(window);
            window.scrollBy = (x, y) => { if (y) window.corrections += 1; scrollBy(x, y); };
            scrollTo(0, document.documentElement.scrollHeight);
        }""")
        page.wait_for_timeout(300)
        page.evaluate("""() => {
            const drawn = [...document.querySelectorAll('.video-card')]
                .map(card => `[data-id="${CSS.escape(card.dataset.id)}"]`);
            const style = document.createElement('style');
            style.textContent = `.video-card:not(${drawn.join(',')}) { padding-bottom: 40px; }`;
            document.head.append(style);
        }""")
        page.mouse.move(700, 450)
        # A card under the pointer should come down by exactly what the wheel
        # scrolled. When the gallery's correction and the browser's scroll
        # anchoring both made up a mounted chunk's height, it went up instead.
        moves = []
        for _ in range(60):
            before = page.evaluate("""() => {
                const card = document.elementFromPoint(700, 450)?.closest('.video-card');
                return card && [card.dataset.id, card.getBoundingClientRect().top];
            }""")
            page.mouse.wheel(0, -120)
            page.wait_for_timeout(100)
            if before:
                moves.append(round(page.evaluate(
                    "id => document.querySelector(`.video-card[data-id='${id}']`)"
                    ".getBoundingClientRect().top", before[0]) - before[1]))
        self.assertGreater(page.evaluate("window.corrections"), 0,
                           "no chunk above the view mounted, so nothing was tested")
        self.assertEqual([move for move in moves if abs(move - 120) > 2], [])
        self.assertEqual(self.failures, [])


if __name__ == "__main__":
    unittest.main()
