"""Describe and stream browser containers without writing playback copies."""
from pathlib import Path

import av


# What the browser can be given for audio, whatever the track's language.
AUDIO_CODECS = {"aac", "opus", "mp3"}


def audio_tracks(container, languages=()) -> list[dict]:
    """Every audio stream, by its index in the file, for a picker to list. A
    Media Source buffer carries one of them, so playing another means asking
    for the stream again with its index. `playable` is only the codec check;
    whether the chosen track also describes itself properly is settled when
    its plan is built.

    yt-dlp does not name a merged stream's language, so a track that has none
    takes it from the sidecar's list, which is in merge order. Only when the
    list is as long as the file's audio streams: anything else means the file
    was changed since, and a guess would label tracks with the wrong language."""
    streams = list(container.streams.audio)
    named = list(languages) if len(languages) == len(streams) else []
    return [{"index": stream.index,
             "language": (stream.metadata.get("language") or "").strip() or (named[position] if named else ""),
             "title": (stream.metadata.get("title") or "").strip(),
             "codec": stream.codec_context.codec.canonical_name,
             "default": bool(stream.disposition & stream.disposition.default),
             "playable": stream.codec_context.codec.canonical_name in AUDIO_CODECS}
            for position, stream in enumerate(streams)]


def playback_plan(path: Path, audio_index: int | None = None, languages=()) -> dict | None:
    """How the browser can play this file through a remux, or None when it is
    better left to native playback. An MKV is always described, since no
    browser plays one; any other container only when it holds several audio
    tracks, which a browser's own player cannot switch between. `audio_index`
    picks the track, and is None for the file's default; `languages` is what
    the sidecar says of each track, for streams that do not say themselves."""
    is_mkv = path.suffix.lower() == ".mkv"
    with av.open(str(path)) as container:
        tracks = audio_tracks(container, languages)
        if not is_mkv and len(tracks) < 2:
            return None
        video = next((stream for stream in container.streams.video
                      if not (stream.disposition & stream.disposition.attached_pic)), None)
        if audio_index is None:
            chosen = next((track for track in tracks if track["default"]), next(iter(tracks), None))
        else:
            chosen = next((track for track in tracks if track["index"] == audio_index), None)
            if chosen is None:
                return None
        audio = next((stream for stream in container.streams.audio
                      if chosen and stream.index == chosen["index"]), None)
        if video is None:
            return None
        vcodec = video.codec_context.codec.canonical_name
        acodec = audio.codec_context.codec.canonical_name if audio else None
        codecs = {"h264": "avc1.640028", "vp9": "vp09.00.10.08",
                  "av1": "av01.0.08M.08", "aac": "mp4a.40.2",
                  "opus": "opus", "mp3": "mp4a.6B"}
        if vcodec not in codecs or (acodec and acodec not in codecs):
            return None
        if vcodec not in {"h264", "av1", "vp9"} or acodec not in {None, "aac", "opus", "mp3"}:
            return None
        # MP4 keeps each track's fragment timeline separate. FFmpeg's WebM
        # Opus codec-delay adjustment can put block timecodes out of order,
        # which Chromium's MSE parser rejects despite native WebM playing it.
        output = "mp4"
        extra = video.codec_context.extradata or b""
        if vcodec == "h264":
            if len(extra) < 4 or extra[0] != 1:
                return None
            codecs[vcodec] = "avc1." + extra[1:4].hex()
        if vcodec == "vp9":
            profile = str(video.codec_context.profile or "Profile 0")[-1]
            if video.codec_context.format is None:
                return None
            depth = video.codec_context.format.components[0].bits
            if profile not in {"0", "1", "2", "3"} or depth not in {8, 10, 12}:
                return None
            codecs[vcodec] = f"vp09.{int(profile):02d}.10.{depth:02d}"
        if vcodec == "av1":
            if len(extra) < 3 or not extra[0] & 0x80:
                return None
            profile, level = extra[1] >> 5, extra[1] & 31
            tier = "H" if extra[2] & 0x80 else "M"
            depth = 12 if extra[2] & 0x20 else 10 if extra[2] & 0x40 else 8
            codecs[vcodec] = f"av01.{profile}.{level:02d}{tier}.{depth:02d}"
        if acodec == "aac":
            audio_extra = audio.codec_context.extradata or b""
            if not audio_extra:
                return None
            object_type = audio_extra[0] >> 3
            if object_type == 31:
                return None
            codecs[acodec] = f"mp4a.40.{object_type}"
        names = [codecs[vcodec]] + ([codecs[acodec]] if acodec else [])
        return {"container": output, "mime": f'video/{output}; codecs="{", ".join(names)}"',
                "duration": float(container.duration or 0) / av.time_base,
                "video": video.index, "audio": audio.index if audio else None,
                "audioTracks": tracks if len(tracks) > 1 else []}


def remux_command(path: Path, plan: dict, start: float) -> list[str]:
    # Preserve the original timeline across seeks. Input seeking retains the
    # preceding keyframe, which the browser needs before decoding the target.
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
               "-copyts", "-start_at_zero", "-ss", str(start), "-i", str(path),
               "-map", f"0:{plan['video']}"]
    if plan["audio"] is not None:
        command += ["-map", f"0:{plan['audio']}"]
    command += ["-c", "copy", "-avoid_negative_ts", "disabled"]
    # Without frag_discont the MP4 muxer rebases the first fragment to
    # zero even with copyts, so a seek would return media at the wrong time.
    # Cut only at keyframes: a timed cut inside a reordered H.264 GOP can
    # make Firefox drop the following frames until the next keyframe.
    command += ["-movflags", "+empty_moov+frag_keyframe+default_base_moof+frag_discont"]
    return command + ["-f", plan["container"], "pipe:1"]
