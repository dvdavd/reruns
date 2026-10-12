# Third-party notices

The Reruns container image bundles software under its own licences. This file
is installed in the image at `/usr/share/doc/reruns/THIRD-PARTY-NOTICES.md`.

## FFmpeg (LGPL)

`ffmpeg` and `ffprobe` in `/usr/local/bin`, with their libraries in
`/usr/local/lib`, are [FFmpeg](https://ffmpeg.org) built from the unmodified
release source by the `ffmpeg` stage of this project's `Dockerfile`, which
shows the exact configuration. It is licensed under the GNU Lesser General
Public License, version 3 or later; the text is in `/usr/share/doc/ffmpeg/`.
The build is not GPL: it includes neither x264 nor x265, and Reruns only ever
copies video, never encodes it.

It links libdav1d (BSD-2-Clause), libmp3lame (LGPL), libopus (BSD-3-Clause)
and OpenSSL (Apache-2.0), which come from Debian's packages. The FFmpeg
libraries are shared, so you may replace them with your own build of the same
version.

The source is `https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz`, where
`<version>` is the `uk.dvdavd.reruns.ffmpeg.version` label on the image. Run
`ffmpeg -buildconf` for the configuration.

## PyAV (BSD-3-Clause)

[PyAV](https://github.com/PyAV-Org/PyAV) is built from its source release
against the FFmpeg above, rather than installed from PyPI, whose wheels bundle a
GPL build of FFmpeg.

## Others

- [yt-dlp](https://github.com/yt-dlp/yt-dlp), Unlicense
- [curl_cffi](https://github.com/lexiforest/curl_cffi), MIT, for yt-dlp browser impersonation
- [Deno](https://github.com/denoland/deno), MIT
- Python packages from `requirements.txt`, each under its own licence, installed
  with their licence files in `site-packages`
- Debian packages from the base image, with licences under `/usr/share/doc`
