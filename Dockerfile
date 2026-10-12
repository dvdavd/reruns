# syntax=docker/dockerfile:1
#
# Reruns, with Python scrub previews and a yt-dlp the server keeps current.
#
#   docker buildx build -t reruns .
#   docker buildx build --platform linux/amd64,linux/arm64 -t reruns .

# Pinned by digest so the registry build cache stays valid: a moving tag
# re-resolves on every run of the release builder, and a new base invalidates
# every layer above it, ffmpeg's hour-long compile included. The tag is kept for
# reading; the digest is what is pulled. To take a base update, replace the
# digest with `docker buildx imagetools inspect python:3.13-slim-trixie`'s.
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb
ARG DENO_VERSION=2.9.7
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3

FROM denoland/deno:bin-${DENO_VERSION} AS deno

# ffmpeg built from source, LGPL, with only what Reruns and yt-dlp use. Video
# is only ever copied or decoded, never encoded, so there is no x264 or x265
# and no GPL obligation. What does get encoded is audio (aac, flac, mp3, opus
# for --audio-format), JPEG and PNG frames (previews, thumbnails) and
# subtitles. Decoders, demuxers, muxers, filters and protocols stay at their
# defaults: they are small, and yt-dlp and live captures reach for a wide
# range of them. libdav1d is there because ffmpeg's own AV1 decoder only
# works through hardware. The libav* libraries are shared, so ffmpeg and
# ffprobe carry one copy between them; the codec libraries and OpenSSL (for
# https and HLS) are the distribution's own, and get its security updates.
# The release tarball is pinned by checksum rather than fetched from a moving
# "latest", so the same Dockerfile gives the same ffmpeg.
FROM ${PYTHON_IMAGE} AS ffmpeg
ARG FFMPEG_VERSION
ARG FFMPEG_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential nasm pkg-config ca-certificates curl xz-utils \
      zlib1g-dev libssl-dev libdav1d-dev libmp3lame-dev libopus-dev \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    curl -fsSLo /tmp/ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"; \
    echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir /src; tar -xf /tmp/ffmpeg.tar.xz -C /src --strip-components=1
WORKDIR /src
RUN ./configure --prefix=/opt/ffmpeg --disable-autodetect --disable-debug --disable-doc \
      --disable-ffplay --enable-version3 --enable-openssl --enable-libdav1d \
      --enable-zlib --enable-libmp3lame --enable-libopus --enable-shared --disable-static \
      --disable-encoders \
      --enable-encoder=aac,flac,libmp3lame,libopus,mjpeg,png,movtext,webvtt,srt,subrip,ass,ssa \
    && make -j"$(nproc)" && make install \
    && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/lib/*.so.* \
    && mkdir -p /opt/ffmpeg/share/doc && cp COPYING.LGPLv3 COPYING.LGPLv2.1 /opt/ffmpeg/share/doc/ \
    && ldd /opt/ffmpeg/bin/ffmpeg

# PyAV's own wheels bundle a GPL ffmpeg (x264, x265, GnuTLS and 100 MB of
# libraries) beside the one above. Building it from source against this
# ffmpeg gives one copy and keeps the image LGPL.
COPY requirements.txt /tmp/requirements.txt
RUN PKG_CONFIG_PATH=/opt/ffmpeg/lib/pkgconfig \
    pip wheel --no-deps --no-binary av -w /wheels "$(grep '^av' /tmp/requirements.txt)"

FROM ${PYTHON_IMAGE}
ARG FFMPEG_VERSION
LABEL uk.dvdavd.reruns.ffmpeg.source="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
      uk.dvdavd.reruns.ffmpeg.version="${FFMPEG_VERSION}"

# Only the copy a fresh config folder starts from; the server replaces it from
# the release channel in settings. "latest" or a release tag such as 2026.08.19.
ARG YTDLP_VERSION=latest
COPY requirements.txt /tmp/reruns-requirements.txt
RUN grep -v '^av' /tmp/reruns-requirements.txt > /tmp/others.txt \
    && python3 -m pip install --no-cache-dir -r /tmp/others.txt

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini libdav1d7 libmp3lame0 libopus0 \
    && rm -rf /var/lib/apt/lists/*

# ffmpeg remains available for downloads and preview compatibility fallback.
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg /opt/ffmpeg/lib/*.so.* /usr/local/lib/
RUN --mount=from=ffmpeg,source=/wheels,target=/wheels \
    ldconfig && python3 -m pip install --no-cache-dir --no-deps /wheels/av-*.whl
COPY --from=ffmpeg /opt/ffmpeg/share/doc /usr/share/doc/ffmpeg

# yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
COPY --from=deno /deno /usr/local/bin/deno

# The zipapp release rather than a platform build: it is pure Python, so one
# file serves every architecture, and it is what the server updates to.
# curl-cffi from requirements.txt supplies its browser impersonation targets.
RUN python3 - <<'EOF'
import hashlib, json, os, urllib.request
version = os.environ.get("YTDLP_VERSION", "latest")
path = "latest" if version == "latest" else f"tags/{version}"
def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "reruns-build"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()
release = json.loads(fetch(f"https://api.github.com/repos/yt-dlp/yt-dlp/releases/{path}"))
assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
sums = dict(reversed(line.split()) for line in fetch(assets["SHA2-256SUMS"]).decode().splitlines())
body = fetch(assets["yt-dlp"])
assert hashlib.sha256(body).hexdigest() == sums["yt-dlp"], "yt-dlp checksum mismatch"
with open("/usr/local/bin/yt-dlp", "wb") as target:
    target.write(body)
os.chmod("/usr/local/bin/yt-dlp", 0o755)
print("yt-dlp", release["tag_name"])
EOF
RUN yt-dlp --list-impersonate-targets

COPY THIRD-PARTY-NOTICES.md /usr/share/doc/reruns/THIRD-PARTY-NOTICES.md
# The checkout is only needed to build the package. Writes made by setuptools
# stay in this temporary mount; only the installed package and assets persist.
RUN --mount=type=bind,source=.,target=/app,rw \
    python3 -m pip install --no-cache-dir --no-deps /app

# The entrypoint repairs bind-mount ownership before dropping privileges.
COPY scripts/docker-entrypoint.py /usr/local/bin/reruns-entrypoint.py
RUN mkdir -p /config /cache /media && chmod 1777 /config /cache

ENV XDG_CONFIG_HOME=/config \
    XDG_CACHE_HOME=/cache \
    DENO_DIR=/cache/deno \
    HOME=/config \
    PYTHONUNBUFFERED=1

VOLUME ["/config", "/cache"]
EXPOSE 8800

HEALTHCHECK --interval=1m --timeout=10s --start-period=1m \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8800/api/auth/config', timeout=5)"

# tini is PID 1 so that ffmpeg processes orphaned by a yt-dlp that died
# first are reaped, rather than piling up as zombies under the server.
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/usr/local/bin/reruns-entrypoint.py"]

# Libraries are chosen in first-run setup using paths inside the container.
CMD ["reruns", \
     "--host", "0.0.0.0", "--port", "8800", \
     "--config", "/config", \
     "--cache", "/cache/seek-previews", \
     "--channel-cache", "/cache/channels", \
     "--browse-cache", "/cache/browse", \
     "--sponsorblock-cache", "/cache/sponsorblock", \
     "--probe-cache", "/cache/media-probes.json", \
     "--manage-yt-dlp"]
