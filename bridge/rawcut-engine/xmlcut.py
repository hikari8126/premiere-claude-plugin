#!/usr/bin/env python3
"""
Raw-cutter - extract every cut of a Premiere Pro timeline as an individual video file.

Reads a Final Cut Pro 7 XML export (Premiere: File > Export > Final Cut Pro XML),
resolves each clipitem back to its source media, and uses ffmpeg to cut the exact
frame range the editor used. Emits a CSV + JSON manifest describing every clip.

Every cut is re-encoded, deliberately: it is the only path that is frame exact. There is
no flag to turn stream copy back on.

Usage:
    python3 xmlcut.py timeline.xml -o ./clips
    python3 xmlcut.py timeline.xml -o ./clips --dry-run
    python3 xmlcut.py timeline.xml -o ./clips --remap "/Volumes/OldDrive=/Volumes/NewDrive"
    python3 xmlcut.py timeline.xml --manifest-only

Requires: ffmpeg + ffprobe on PATH. No third-party Python packages.
"""

from __future__ import annotations

import argparse
import atexit
import bisect
import collections
import contextlib
import csv
import hashlib
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import textwrap
import tempfile
import sys
import threading
import time
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict, replace
from fractions import Fraction
from pathlib import Path
from typing import Optional, Union

VERSION = "3.93"

# Files this tool writes into an output folder: an index prefix, then anything, then a
# media extension. Used to tell an earlier run's leftovers from a user's own files, which
# must never be reported as strays.
CUT_FILE_RE = re.compile(r"^\d+_.*\.(?:mp4|mov|mkv|m4v|m4a|wav|mp3|aac)$", re.I)

# ⚠️ HOW FAR BEFORE AN AUDIO IN-POINT TO SEEK, in seconds, before trimming the lead back off
# inside the filter graph. Input-side `-ss` on an AUDIO-ONLY AAC file drops the encoder's
# priming from the head — MEASURED with a click train: 1024 − (S·48000 mod 1024) samples gone,
# so the next click arrived 21.3 ms early at S=0, 6.0 at 0.25, 12.0 at 0.5, 2.7 at 1.0; an
# Apple-encoded m4a (2112 priming) lost 33.3 ms, a whole 30 fps frame. WAV and MP4-with-video
# sources lose nothing, which is why the comment that said "-ss on audio is honoured to the
# sample" was true on the fixture it was measured with and false on the file type an editor's
# voice-over actually arrives as. Seeking a tenth of a second early and `atrim`ming exactly
# that much back off was measured exact on both encoder families; -advanced_editlist 0 was
# not (it fails on Apple files) and -ignore_editlist lands 21 ms late.
AUDIO_SEEK_LEAD = 0.1

# ⚠️ HOW SHORT AN AUDIO DELIVERY MAY BE BEFORE IT IS REFUSED, in seconds. An audio cut pins
# no -frames:v — there is no frame to count — so until the out_time receipt in run_cut
# nothing at all compared its length with the length it was asked for, and a cut whose
# source runs out mid-range shipped at whatever ffmpeg wrote, status ok: MEASURED on an
# 8.000 s source, a 7.0-9.0 s cut delivered 1.000000 s of the 2.0 s asked and was reported
# `Done: 2 written`. Only a cut WHOLLY past the end failed, and then via the streamless-file
# check rather than a length one.
#
# 50 ms, not zero, and the number is an AAC frame: 1024 samples is 21.3 ms at 48 kHz, and an
# Apple-encoded m4a's 2112-sample priming is 33.3 ms (see AUDIO_SEEK_LEAD, where the same two
# numbers were measured). Anything under one frame of slop is encoder bookkeeping, not a
# missing tail. Checked in ONE direction only: a long delivery is priming the decoder throws
# away, a short one is media that is not there.
AUDIO_SHORT_TOLERANCE = 0.05

# ⚠️ THE MOST SILENCE A RETIMED AUDIO CUT MAY BE PADDED WITH, in seconds, to make up what
# atempo's WSOLA window swallowed off the tail — see the pin in build_command's audio branch.
# Deliberately a CAP rather than an open `apad`: an unbounded pad would fill a source that
# ran out mid-range with silence and hide it from the out_time receipt above. The widest
# residue measured was 2944 samples (61.3 ms, at 50% speed); a quarter second leaves room for
# a chained atempo and still fails anything genuinely missing.
AUDIO_RETIME_PAD = 0.25

# The product name, for anything a person reads. Deliberately NOT applied to the
# identifiers: this file's own name, PANEL_ID, the release-channel repo, the dump's
# GENERATOR string and the panel's localStorage keys are all load-bearing, and renaming
# any of them would break every installed copy's updater, duplicate the panel in
# Premiere's Extensions menu, or silently drop saved settings.
NAME = "Raw-cutter"

# Stills sit on the timeline for N frames but have no playable duration —
# they need -loop instead of -ss/-t.
STILL_EXT = {".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff", ".bmp",
             ".tga", ".gif", ".exr", ".dpx", ".webp", ".ai", ".eps",
             ".heic", ".heif", ".avif"}

# ⚠️ 3.93 AUDIT · THE PHONE'S PHOTO FORMATS ARE STILLS, BUT FFMPEG CANNOT LOOP THEM. They were
# in no set, so an iPhone photo on the timeline classified as VIDEO, was seeked to its virtual
# 24-hour in-point and failed with "the source is shorter than the cut, or unreadable" under a
# name carrying that clock (MEASURED on 3.93: 01_(3596.40-3597.90)_still.mp4). Classifying
# them as stills is not enough: they open through the mov demuxer, which refuses the still
# branch's `-loop 1`, and a full-size iPhone photo is a GRID of 512x512 tiles that ffprobe
# reports as the first tile. So each one is converted once, by macOS's own sips, to a PNG
# the ordinary still path can read and probe — see still_input().
HEIF_EXT = {".heic", ".heif", ".avif"}

# Project/comp files that ffmpeg cannot decode (dynamic-link, not media).
#
# ⚠️ .aegraphic AND .mogrt WERE MISSING, and because they are in neither this set nor
# STILL_EXT they classified as ordinary decodable video — so an Essential Graphics
# template WITH a file on disk was offered as cuttable footage that ffmpeg then cannot
# open. On the reporter's timeline that was 37 of 56 cuts.
#
# They are RENDERABLE, unlike a .prproj: Premiere resolves them while rendering, so they
# behave exactly like an .aep here — refused with a reason in source mode, offered under
# --render-planned, and cut from a render when one exists. describe() words them as
# "graphic — needs a render" rather than "AE comp", which is what they are.
#
# ⚠️ PAIRED WITH panel/client/main.js:1039 (DEAD_TYPES). If the panel's copy of this list
# disagrees, a type the engine refuses arrives ticked by default, or the reverse.
UNSUPPORTED_EXT = {".aep", ".prproj", ".psb", ".c4d", ".aet", ".ppj", ".fcpxml",
                   ".aegraphic", ".mogrt"}

# Premiere's native time unit. <pproTicksIn>/<pproTicksOut> give the source range in
# absolute seconds — immune to frame-rate conforming AND already correct for speed
# ramps, unlike <in>/<out>, which on a retimed clip describe the pre-remap range.
PPRO_TICKS_PER_SECOND = 254016000000

# Nested sequences are resolved recursively; the cap is a runaway guard, not a limit
# anyone should hit deliberately.
MAX_NEST_DEPTH = 4

# The encoder settings, decided once rather than exposed as knobs.
#
# crf 1, NOT crf 0. This was lossless (crf 0) until a clip turned out to be unplayable on
# another Mac, and the reason is not obvious: x264's lossless mode emits the
# **High 4:4:4 Predictive** profile even when the pixel format is plain yuv420p, and
# QuickTime, Finder preview and Premiere's macOS decoders cannot read that profile at all.
# Measured on one 2-second clip:
#
#     crf 0   1000 KB   profile "High 4:4:4 Predictive"  <- will not play on a Mac
#     crf 1    712 KB   profile "High"                   <- plays everywhere
#
# So crf 1 is both smaller and playable, and visually indistinguishable. What is given up
# is the strict bit-exactness — worth knowing, but a dataset you cannot preview is worse.
# `-profile:v high` is pinned explicitly so this can never silently drift back to 4:4:4.
#
# veryfast rather than medium because the preset only changes how hard x264 works to
# compress; it never moves a frame boundary. Measured frame-exact at every preset.
X264_CRF = "1"
X264_PRESET = "veryfast"
X264_PROFILE = "high"

# Video-only output, and not merely as a default: an AAC track makes the CONTAINER
# declare a duration longer than the video stream it holds. AAC needs priming samples,
# so the audio outruns the video by ~40 ms — one frame — and an NLE reading the container
# imports every clip a frame long. Neither `-shortest` nor trimming the audio fixes the
# mp4 header; only leaving audio out does. Measured: 48 frames of 24 fps video declared
# 2.041 s with audio, 2.000 s without.
#
# Extracting audio-track clips on their own (`--tracks audio`) is a different job and
# still works; it writes .m4a files where audio is the point.

# How many clips to encode at once. Not auto-detected from the core count, and
# deliberately not the core count itself: libx264 already parallelises across every
# core inside a single encode, so extra concurrent encodes only add contention.
# Measured on 24 clips of 1080x1920 (at crf 0, as it then was), best of two runs each:
#     4 jobs 7.2s · 7 jobs 7.7s · 14 jobs 8.3s · 14 jobs w/ 2 threads 7.9s
# i.e. more jobs is SLOWER, and the whole spread is 19%. Four would win on local
# media, but sources on Google Drive File Stream block on network reads, and there
# parallelism does pay — so this sits in the middle and is capped so it stays sane on
# an 8-core laptop as well as a 14-core desktop.
JOBS = min(8, os.cpu_count() or 4)

# --------------------------------------------------------------------------
# export settings
# --------------------------------------------------------------------------
#
# These used to be pinned constants with a note saying they were "decided once rather
# than exposed as knobs". They are now adjustable, and the note still matters — the
# DEFAULTS are the measured ones, and moving off them has consequences the tool states
# rather than leaves to be discovered:
#
#   crf        1 is the default because crf 0 emits High 4:4:4 Predictive, which will
#              not play on a Mac. Raising crf costs quality and saves a lot of space.
#              Fractional values are real, not rounded away — see crf_of().
#   bitrate    an alternative to crf, not an addition. Target-rate mode makes file size
#              predictable, which is the reason to want it.
#   fps        ⚠️ CHANGING THIS BREAKS FRAME EXACTNESS. Resampling to another rate
#              drops or duplicates frames, so the file no longer holds the frames the
#              timeline used. Recorded per clip as frame_exact=false, and said out loud.
#              Asked PER CUT — forcing the rate the media already has is a no-op and is
#              not emitted at all, because emitting it corrupts the head.

# Output bitrate relative to the SOURCE's, measured per crf on the fixture media:
#     crf  1 -> 2.77x    crf 14 -> 1.26x    crf 18 -> 0.94x
#     crf 23 -> 0.62x    crf 28 -> 0.37x
# Content-dependent — detailed footage lands higher, flat footage lower — so anything
# derived from it is presented as an estimate and never as a promise.
CRF_SIZE_RATIO = {1: 2.77, 14: 1.26, 18: 0.94, 23: 0.62, 28: 0.37}

# --------------------------------------------------------------------------
# THE SIZE MODEL — metadata only, so it costs nothing and follows a slider live.
# --------------------------------------------------------------------------
#
# CALIBRATED by encoding real clips at six crf values and measuring what came out. That
# calibration ran ONCE, offline; nothing here encodes anything. The measurements are in
# CLAUDE.md; these are the tables they produced.
#
# The unit is OUTPUT BITS PER PIXEL PER FRAME, which is the thing that clusters. Two facts
# came out of the calibration and both are load-bearing:
#
#   1. CODEC CLASS separates it. Intraframe sources in this workflow are camera or studio
#      originals and encode to roughly a third of the bits an already-compressed source of
#      the same size does, because a re-encode has to reproduce the first encoder's
#      artefacts as well as the picture. Output bpp at crf 14: h264 0.15-0.30, ProRes
#      0.068-0.087.
#
#   2. A SOURCE'S OWN BITRATE IS A CEILING, NOT A PREDICTOR. Scaling it — which is what
#      this used to do — is right in kind only for inter-frame footage at ordinary rates,
#      and was 186x wrong on a 632 Mbps ProRes. It is kept only as an upper bound for the
#      inter-frame path, where a genuinely low-bitrate source really does encode small.
#
# Accuracy, against the 40 real measurements it was fitted to: median 1.00x, 37/40 within
# 1.5x, 38/40 within 2x, worst 5.7x on a 4K clip at crf 28 where output collapses faster
# than any table follows. It is an ESTIMATE and the wording everywhere says so.
INTRAFRAME_CODECS = {
    "prores", "dnxhd", "dnxhr", "mjpeg", "cineform", "v210", "v410", "rawvideo",
    "ffv1", "huffyuv", "dvvideo", "hq_hqa", "hqx", "cfhd", "prores_ks",
}

BPP_INTER = {6: 0.759, 14: 0.290, 18: 0.144, 23: 0.066, 28: 0.032}
BPP_INTRA = {6: 0.261, 14: 0.069, 18: 0.030, 23: 0.013, 28: 0.006}
SRC_SHARE = {6: 2.806, 14: 1.074, 18: 0.598, 23: 0.288, 28: 0.144}

# ⚠️ CRF IS NOT THE SAME NUMBER IN BOTH ENCODERS, and the difference is not the flat "HEVC
# is half the size" that every comparison chart promises. Those charts hold QUALITY equal;
# this panel holds the CRF NUMBER equal, because that is the knob on screen, and the two
# are not the same question.
#
# Every table above is x264's. This is what x265 costs as a multiple of it, measured on 19
# real clips — 14 h264 from a production timeline plus 5 of them rewrapped to ProRes — both
# encoders, same slices, same preset, PAIRED PER CLIP so content cancels out:
#
#     crf  6   1.01x   (0.77-1.09)   <- NO SAVING AT ALL at the near-lossless end
#     crf 14   0.72x   (0.53-1.02)
#     crf 18   0.70x   (0.48-0.96)
#     crf 23   0.78x   (0.53-0.99)
#     crf 28   0.82x   (0.54-1.04)   <- and the saving shrinks again as crf climbs
#
# Predicting the direct x265 measurements from the x264 ones through this table lands
# within 0.97-1.11x, so the ratio carries; it is the LEVEL that is inherited from the x264
# fit, which had more clips behind it than these 19.
#
# It scales the source ceiling as well as bpp. Both are the same measured rate over a
# per-clip constant, so the paired ratio is arithmetically identical for either.
#
# ⚠️ STILLS ARE NOT SCALED BY IT. A real jpeg at the same five values came out
# 1.13/1.00/1.00/1.01/1.06x — x265's win is prediction BETWEEN frames and a still has none
# to do. The saving is a property of moving pictures, not of the encoder.
CODEC_BPP_RATIO = {
    "libx265": {6: 1.01, 14: 0.72, 18: 0.70, 23: 0.78, 28: 0.82},
}


def _interp(table: dict, crf: float) -> float:
    keys = sorted(table)
    if crf <= keys[0]:
        return table[keys[0]]
    if crf >= keys[-1]:
        return table[keys[-1]]
    for a, b in zip(keys, keys[1:]):
        if a <= crf <= b:
            f = (crf - a) / (b - a)
            return table[a] + f * (table[b] - table[a])
    return table[keys[-1]]

def codec_ratio(vcodec: str, crf: float) -> float:
    """How this encoder's output compares with x264's at the SAME crf number.

    x264 is 1.0 by definition — the tables were fitted to it. An encoder with no measured
    ratio is also 1.0, which keeps a future --vcodec honest: it shows the x264 figure it
    actually has evidence for rather than a discount nobody measured.
    """
    t = CODEC_BPP_RATIO.get(str(vcodec or ""))
    return _interp(t, crf) if t else 1.0



# A STILL is not a rate. Almost all of its file is the one keyframe; every frame after that
# is a few bytes of "nothing changed", so its cost barely moves with duration. Modelling it
# per-second over-predicted an 18x — a 1.5s still that weighs 2859 bytes was estimated at
# 52 kB. So it is priced as this many frames' worth of picture, whatever its length.
#
# 1.5 is fitted to one file (321x241, crf 18, 2859 bytes actual -> 0.91x), so it is a rough
# number honestly labelled rather than a calibrated one. Stills are a rounding error in any
# export that also contains video, which is why it has not been measured harder.
STILL_FRAMES = 1.5


def encode_input(cut: Cut) -> tuple:
    """(width, height, fps, codec, bitrate) of the file ffmpeg will actually read.

    ONE definition, because in render mode every one of these differs from the source's:
    a 4K 60p clip placed in a 1080 25p sequence is read back as 1080 25p H.264. Pricing
    or measuring it from the source clip would be wrong on all five counts, and the four
    call sites had no business each deciding that for themselves.
    """
    if cut.render_path:
        return (cut.render_width, cut.render_height, cut.render_fps,
                cut.render_codec, cut.render_bitrate)
    return (cut.width, cut.height, cut.source_fps, cut.codec, cut.bitrate)


def estimate_bytes_for(cut: Cut, crf: float, pct: float, secs: float,
                       vcodec: str) -> float:
    """Expected output size in BYTES. Stills and video price differently, so the one
    function that callers use returns bytes rather than a rate.

    vcodec is REQUIRED rather than defaulted. A default would let a caller quietly price an
    x265 export at x264 rates, which is the whole bug this parameter exists to fix; missing
    it should be a TypeError the first time the tests run, not a number that looks fine.
    """
    # ⚠️ AN AUDIO CUT IS PRICED AS AUDIO, not by the picture its source happens to carry.
    # Every audio branch of build_command asks ffmpeg for `-c:a aac -b:a 192k`, so the size
    # is the duration times that rate and nothing else — no width, no frame rate, no crf.
    # Pricing it with the video model read w/h/fps off the SOURCE video file and produced a
    # number about twenty times the delivered .m4a, and moved it with the quality slider
    # although the delivered bytes are identical across the whole slider (measured
    # byte-for-byte). The panel was corrected first; this is the same fix on the engine
    # side, so the header total and the panel's column stop disagreeing.
    #
    # 192 kbps is what the code ASKS for, so this is a ceiling rather than a fit: a
    # voice-over lands under it. Over-stating a delivery is the safe direction for someone
    # sizing a drive, and a constant fitted to one fixture would under-state a music bed.
    if cut.track_type == "audio":
        return AUDIO_ESTIMATE_BPS * secs / 8 + CONTAINER_FIXED
    if cut.media_kind == "still" and not cut.render_path:
        w, h = scaled_dims(cut.width, cut.height, pct)
        if not w or not h:
            return 0.0
        # NOT scaled by codec_ratio, and that is measured, not an oversight — see
        # CODEC_BPP_RATIO. A still gives x265 no inter prediction to be better at, and a
        # real jpeg encoded both ways came out the same size to within a percent.
        return _interp(BPP_INTER, crf) * w * h * STILL_FRAMES / 8 + CONTAINER_FIXED
    bps = estimate_bps(cut, crf, pct, vcodec)
    return (bps * secs / 8 + CONTAINER_FIXED) if bps > 0 else 0.0


def estimate_bps(cut: Cut, crf: float, pct: float, vcodec: str) -> float:
    """Expected OUTPUT bits per second for this cut, from metadata alone.

    Needs width, height and a frame rate; without them there is nothing to scale and the
    caller falls back or shows nothing rather than inventing a figure.
    """
    in_w, in_h, in_fps, in_codec, in_rate = encode_input(cut)
    w, h = scaled_dims(in_w, in_h, pct)
    fps = in_fps or 0.0
    if not w or not h or fps <= 0:
        return 0.0
    px = w * h * fps
    intra = (in_codec or "").lower() in INTRAFRAME_CODECS
    # One ratio, applied to whichever table and to the ceiling below, because the encoders
    # differ by a factor of the RATE and everything here is a rate.
    ratio = codec_ratio(vcodec, crf)
    bpp = _interp(BPP_INTRA if intra else BPP_INTER, crf) * ratio
    if not intra and in_rate:
        # The input's own bits per pixel, as a CEILING. A downscale reduces the pixels but
        # not the input's detail per pixel, so the ceiling is computed at the INPUT's
        # dimensions and then applied to the output's.
        spx = (in_w or 1) * (in_h or 1) * fps
        if spx > 0:
            src_bpp = float(in_rate) / spx
            bpp = min(bpp, src_bpp * _interp(SRC_SHARE, crf) * ratio)
    return bpp * px


def size_ratio_for_crf(crf: float) -> float:
    """Linear interpolation between the measured points, clamped outside them."""
    keys = sorted(CRF_SIZE_RATIO)
    if crf <= keys[0]:
        return CRF_SIZE_RATIO[keys[0]]
    if crf >= keys[-1]:
        return CRF_SIZE_RATIO[keys[-1]]
    for a, b in zip(keys, keys[1:]):
        if a <= crf <= b:
            f = (crf - a) / (b - a)
            return CRF_SIZE_RATIO[a] + f * (CRF_SIZE_RATIO[b] - CRF_SIZE_RATIO[a])
    return CRF_SIZE_RATIO[keys[-1]]


def crf_of(args) -> Union[int, float]:
    """ONE reading of --crf. It is consulted by the encoder flags, the size estimate, the
    printed summary and the manifest, and four separate `int(getattr(...))` expressions
    meant four chances for the panel to show one setting while ffmpeg was given another.

    Fractional is deliberate and was measured, not assumed: x264 takes a float, and 18.5
    really does encode differently from 18 (10627 vs 10829 bytes on a one-second test
    clip). An integer-only crf gave the slider 35 positions over its whole range.

    Whole values come back as an int, which is what puts `"crf": 1` rather than
    `"crf": 1.0` in the manifest. That file gets diffed between runs, and a value
    changing shape on the day crf became a float would read as a setting that moved when
    nothing did.

    0 keeps falling back to the default, as it always has — crf 0 emits High 4:4:4
    Predictive, which will not play on a Mac.
    """
    v = float(getattr(args, "crf", None) or X264_CRF)
    return int(v) if v == int(v) else v


def crf_text(v: Union[int, float]) -> str:
    """The same value as ffmpeg is given it and as the summary prints it: 18, or 18.5."""
    f = float(v)
    return str(int(f)) if f == int(f) else str(round(f, 2))


def vcodec_of(args) -> str:
    """ONE reading of --vcodec, for the reason crf_of exists. The encoder flags, the size
    estimate, the printed summary and the manifest all consult it, and five separate
    `getattr(args, "vcodec", None) or "libx264"` expressions were five chances for the
    panel to show one encoder while ffmpeg was handed another.
    """
    return str(getattr(args, "vcodec", None) or "libx264")


# Output resolution, as a percentage of each source's own. 100 = untouched.
#
# ⚠️ This changes what the PIXELS are, not how many frames there are. Frame count is
# unaffected — measured: a 79-frame cut is still 79 frames at 50% — so `frame_exact`
# stays true and verify.py still grades the export. `--fps` resamples TIME and breaks
# that; this resamples SPACE and does not.
#
# For a dataset it is the largest single size lever there is, and a much bigger one than
# crf. Measured on real 1080x1920 and 2160x3840 cuts at crf 14, bytes as a percentage of
# the same clip at 100%:
#
#     scale    pixels    BR_2     K8_after   BR_1_Back_hook
#     75%      56.3%     39.6%      55.7%       56.5%
#     50%      25.0%     12.2%      27.5%       24.9%
#     33%      10.9%      3.9%      14.2%       11.4%
#
# So bytes track PIXEL COUNT — scale squared — within about a third either way, and fall
# well below it on detailed footage where downscaling averages the fine detail away.
# Scale-squared is the estimate; it is not a bound in either direction.
SCALE_DEFAULT = 100.0


def scale_of(args) -> float:
    """ONE reading of --scale, in percent. Same reason as crf_of()."""
    v = getattr(args, "scale", None)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return SCALE_DEFAULT
    return SCALE_DEFAULT if v <= 0 else max(1.0, min(100.0, v))


def scaled_dims(w: Optional[int], h: Optional[int], pct: float):
    """The dimensions ffmpeg will actually produce, computed the SAME way it computes
    them, so the manifest and the panel cannot promise a size the file does not have.

    Both axes are truncated to an even number because H.264 in yuv420p subsamples chroma
    2x2 and an odd dimension is not encodable at all — the encode fails outright rather
    than rounding for you. `trunc(x/2)*2` here mirrors `trunc(iw*S/2)*2` in the filter,
    and the two were checked against each other on real clips (1080x1920 at 33% gives
    356x632 in both).
    """
    if not w or not h:
        return (None, None)
    f = pct / 100.0
    return (max(2, int(w * f / 2) * 2), max(2, int(h * f / 2) * 2))


def scale_filter(args) -> Optional[str]:
    """The scale step of the video filter chain, or None when nothing is being resized.

    build_command has three video exits — stills, retimed, plain — and each would
    otherwise grow its own copy of this. That is precisely the mistake codec_flags() was
    written to stop, and a scale applied to two of three would only show up on a timeline
    containing the third.

    `bicubic` is pinned rather than left to ffmpeg's default so that the same clip run
    through two different ffmpeg builds produces the same pixels. A dataset that changes
    when the toolchain updates is not a fixed dataset.
    """
    pct = scale_of(args)
    if pct >= 100.0:
        return None
    f = pct / 100.0
    return (f"scale=trunc(iw*{f:.6f}/2)*2:trunc(ih*{f:.6f}/2)*2:flags=bicubic")


def parse_bitrate(s: str) -> Optional[int]:
    """'8M', '8000k', '8000000' -> bits per second. None if it is not a rate."""
    if not s:
        return None
    m = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*([kKmM]?)\s*", str(s))
    if not m:
        return None
    v = float(m.group(1))
    return int(v * {"": 1, "k": 1e3, "K": 1e3, "m": 1e6, "M": 1e6}[m.group(2)])


def presets_path() -> Path:
    return (Path.home() / "Library" / "Application Support" / "Raw-cutter"
            / "presets.json")


def load_presets() -> dict:
    """Named export settings. Shared by the CLI, the panel and the browser GUI — a file
    rather than the panel's localStorage, so a preset can be inspected, edited and used
    from a terminal, and so the panel is not the only thing that knows about it."""
    return load_presets_checked()[0]


def load_presets_checked() -> tuple[dict, str]:
    """(the presets, "") — or ({}, why) when a presets.json is THERE and cannot be read.

    ⚠️ 3.93 AUDIT · MISSING AND UNREADABLE ARE DIFFERENT, AND ONLY ONE OF THEM IS EMPTY. Every
    exception used to come back as {}: a hand edit that left a trailing comma, or a file cut
    short, looked exactly like "no presets yet" — and save_preset started from that {} and
    wrote a file holding only the new preset. MEASURED on 3.93: two presets and a trailing
    comma, the panel's Save of a third -> the file held only the third. So an unreadable file
    is reported (--list-presets-json carries it as `error`) and never written over; see
    save_preset.
    """
    p = presets_path()
    try:
        raw = p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, ""
    except OSError as e:
        return {}, f"{p} could not be read ({e})"
    try:
        d = json.loads(raw)
    except ValueError as e:
        return {}, f"{p} is not valid JSON ({e})"
    if not isinstance(d, dict):
        return {}, f"{p} does not hold a set of named presets"
    return d, ""


class PresetsUnreadable(ValueError):
    """presets.json is there and cannot be read, so nothing may be written over it."""


def _write_presets(all_: dict) -> None:
    """Through a temporary file and a rename, so an interrupted write can never leave a
    truncated presets.json behind (which is how a file becomes unreadable by itself)."""
    p = presets_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.part")
    try:
        tmp.write_text(json.dumps(all_, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(str(tmp), str(p))
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# The encoder belongs here for the same reason crf and scale do: it DETERMINES THE
# SIZE. It was missed when the encoder dropdown shipped in v3.26, so a preset saved
# at H.265 came back as H.264 — the panel then named one encode and ran another,
# under a name the person had chosen precisely to stop having to remember it.
PRESET_FIELDS = ("container", "vcodec", "crf", "bitrate", "x264_preset", "fps",
                 "scale")


def save_preset(name: str, settings: dict) -> None:
    """Add or replace one preset. Raises PresetsUnreadable, writing nothing, when the file
    is there and cannot be read — starting from {} would delete every preset in it."""
    all_, bad = load_presets_checked()
    if bad:
        raise PresetsUnreadable(
            f"{bad}. Nothing was saved, so the presets in it are not overwritten — fix the "
            f"file or move it aside, then save again")
    all_[name] = {k: settings.get(k) for k in PRESET_FIELDS}
    _write_presets(all_)


def preset_from_args(args) -> dict:
    """What a preset records, read off one parsed command line.

    ONE function for TWO callers — a --presets-only run, and an export that also saves.
    Both used to spell this dict out by hand, which is how "vcodec" went missing: naming a
    field in PRESET_FIELDS does nothing if the caller never puts it in the dict, and no
    panel-side test can see that, because the panel only ever sees what came back out.
    Adding a field now means adding it here, once, for both callers.
    """
    return {
        "container": args.container,
        # vcodec_of, not args.vcodec: --vcodec has no argparse default, so a preset saved on
        # the default encoder would otherwise record None and leave a reader guessing.
        "vcodec": vcodec_of(args),
        # A preset cannot mean both a quality and a rate, so targeting a bitrate drops
        # the crf rather than storing two settings that contradict each other.
        "crf": (None if parse_bitrate(args.bitrate or "") else args.crf),
        "bitrate": args.bitrate or None,
        "x264_preset": args.x264_preset,
        "fps": args.fps,
        "scale": args.scale,
    }


# What libx264 can encode directly. Anything outside this has to be converted, which is
# a real loss, so it gets recorded rather than done quietly.
X264_PIX_FMTS = {
    "yuv420p", "yuvj420p", "yuv422p", "yuvj422p", "yuv444p", "yuvj444p",
    "nv12", "nv16", "nv21", "yuv420p10le", "yuv422p10le", "yuv444p10le",
    "nv20le", "gray", "gray10le",
}


# --------------------------------------------------------------------------
# self update
# --------------------------------------------------------------------------
#
# Teammates get fixes by clicking Update, not by being sent a new zip. The version
# lives in latest.json in a small PUBLIC repo — public because a private one would need
# an access token inside the tool, i.e. a credential handed to everyone who installs it.
#
# ⚠️ Trust model, stated plainly: anyone able to push to that repo can run code on every
# machine running xmlcut. It is the same bargain as any auto-updater, and the reason the
# owner/repo/branch below are pinned constants rather than anything configurable.

UPDATE_OWNER = "mill2nn"
UPDATE_REPO = "xmlcut-releases"
UPDATE_BRANCH = "main"
# Released files live in a subfolder of the releases repo, not at its root. The root has to
# stay free for that repo's own README, which is the page people land on — publishing the
# project README to the root overwrote it, twice.
UPDATE_DIR = "app"
UPDATE_FILES = [
    "xmlcut.py", "xmlcut_gui.py", "README.md", "Open xmlcut GUI.command",
    # The Premiere panel rides along, so a teammate never re-downloads anything: the
    # files land under <install>/panel/ and are then copied into Adobe's extensions
    # folder by reinstall_panel(). Subpaths are why safe_rel() exists.
    "panel/CSXS/manifest.xml",
    "panel/client/index.html",
    "panel/client/main.js",
    "panel/client/style.css",
    "panel/client/CSInterface.js",
    "panel/jsx/host.jsx",
    "panel/.debug",
    "panel/Install xmlcut reader (Mac).command",
    "panel/Uninstall xmlcut reader (Mac).command",
    # The diagnostics ship too. They were not in this list, so the shareable zip had no
    # tools/ at all — which meant the installer's `if [ -d "../tools" ]` never fired and
    # a teammate could never run compare_panel.py, while the panel's Advanced pane still
    # carried a command for it. They are a few KB; shipping them is cheaper than
    # explaining that they only work on one machine.
    "tools/compare_panel.py",
    "tools/source_check.py",
    "tools/speed_check.py",
]

# Where the panel has to end up for Premiere to see it.
PANEL_ID = "com.bom.xmlcutreader"
PANEL_PARTS = ["CSXS", "client", "jsx", ".debug"]

# A released file may begin with a dot only if it is one of these. Nothing else has a
# reason to, and `.zshrc` used to pass safe_rel() — harmless, since everything is written
# under the install directory, but there is no case for allowing it.
DOT_OK = {".debug"}

# No released file is anywhere near this big. Without a cap, a wrong URL or a hostile
# repo hands urlopen an arbitrarily large body straight into memory.
MAX_UPDATE_BYTES = 8 * 1024 * 1024

# And no released file is anywhere near this small. Measured across the 13 files this
# release ships: the smallest is CSInterface.js at 532 bytes, so 200 is under the real
# floor by more than a factor of two and can only fire on a body that is not the file.
MIN_RELEASE_BYTES = 200

# Left beside the installed xmlcut.py when the engine updated but the panel copy did not,
# holding that version. It is what makes the next check offer the same number again
# instead of "up to date" — see newer_than_running().
PANEL_REPAIR_MARKER = ".panel-repair-needed"


def cep_extensions_dir() -> Path:
    return (Path.home() / "Library" / "Application Support" / "Adobe" / "CEP"
            / "extensions")


def is_bundled_install(here: Optional[Path] = None) -> bool:
    """True when the running xmlcut.py is the copy inside Premiere's extension folder.

    The panel ALWAYS runs that copy, which makes install_dir() the extension's lib/ —
    not the folder the user downloaded. Until this was accounted for, pressing Update in
    the panel wrote xmlcut_gui.py, README.md, a launcher and a whole second panel/ tree
    into Adobe's extensions directory, and left the user's own folder on the old version:
    two installations, one of them invisible.
    """
    here = here or install_dir()
    try:
        return cep_extensions_dir().resolve() in here.resolve().parents
    except Exception:
        return False


def safe_rel(name: str) -> Optional[str]:
    """A relative path from latest.json, or None if it is not one we will write.

    latest.json comes from a PUBLIC repo, so its filenames are untrusted input. This
    used to be `Path(f).name`, which neutralised traversal by throwing the directory
    away — fine until the panel needed `panel/client/main.js` to stay nested.

    So: forward slashes only, no absolute paths, no `..`, no hidden directories, a
    conservative character set, and a depth cap. Anything else is skipped rather than
    guessed at.
    """
    if not name or "\\" in name or name.startswith("/"):
        return None
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or len(parts) > 4:
        return None
    for i, p in enumerate(parts):
        if p == ".." or not re.fullmatch(r"[A-Za-z0-9 ._()+-]+", p):
            return None
        # A leading dot is allowed only on the final component AND only for a name we
        # actually ship. Never as a directory — nothing should write into a dot-directory.
        if p.startswith(".") and (i != len(parts) - 1 or p not in DOT_OK):
            return None
    return "/".join(parts)


def reinstall_panel(here: Path, progress=None) -> tuple[bool, str]:
    """Copy <install>/panel into Adobe's extensions folder.

    An update refreshes the files in the xmlcut folder, but Premiere loads the panel
    from its own directory — so without this step a teammate's panel stays on the old
    code no matter how many times xmlcut updates itself.

    Premiere only scans extensions at launch, so the caller has to say "restart
    Premiere". Copying under a running Premiere is safe; it simply keeps using what it
    already loaded.
    """
    src = here / "panel"
    if not src.is_dir():
        return False, "no panel/ folder in this install — nothing to reinstall"
    dest = cep_extensions_dir() / PANEL_ID
    try:
        dest.mkdir(parents=True, exist_ok=True)
        # xmlcut.py goes INSIDE the installed panel, as lib/xmlcut.py.
        #
        # The panel used to hunt for it in ~/Desktop and friends, which fails outright
        # when macOS has not granted Premiere access to those folders — the file is
        # there and every stat says no. The extension directory is one Premiere already
        # reads to load the panel at all, so a copy in here is always reachable.
        #
        # Copied at install time rather than committed under panel/, so the repository
        # keeps exactly one xmlcut.py and the two can never drift.
        lib = dest / "lib"
        lib.mkdir(parents=True, exist_ok=True)

        # `here` and `lib` are the SAME DIRECTORY when the caller is the bundled copy —
        # which is every update the panel performs, since install_dir() is then the
        # extension's own lib/. Copying a directory onto itself is not a no-op here: the
        # tools branch did `rmtree(tdst)` and then globbed `tsrc`, so every panel update
        # deleted the bundled diagnostics and left an empty lib/tools. Measured, three
        # files to none. Compare resolved paths and skip rather than copy.
        def same(a: Path, b: Path) -> bool:
            try:
                return a.resolve() == b.resolve()
            except Exception:
                return False

        if not same(here / "xmlcut.py", lib / "xmlcut.py"):
            (lib / "xmlcut.py").write_bytes((here / "xmlcut.py").read_bytes())
            if progress:
                progress("panel: lib/xmlcut.py")
        # The diagnostics come too, as lib/tools/. They do
        # sys.path.insert(parent.parent), which from lib/tools/ resolves to lib/ — where
        # xmlcut.py now is — so they run from inside the panel unchanged. Without them
        # the compare command the panel prints points at a folder that does not exist.
        tsrc = here / "tools"
        tdst = lib / "tools"
        if tsrc.is_dir() and not same(tsrc, tdst):
            shutil.rmtree(tdst, ignore_errors=True)
            tdst.mkdir(parents=True, exist_ok=True)
            for t in sorted(tsrc.glob("*.py")):
                (tdst / t.name).write_bytes(t.read_bytes())
            if progress:
                progress("panel: lib/tools")
        # ⚠️ STAGED AND SWAPPED, NEVER DELETED-THEN-COPIED. This was
        # `rmtree(d, ignore_errors=True)` followed by `copytree(s, d)` straight into the
        # folder Premiere loads, so anything that stopped the copy part-way left the panel
        # in whatever state the copy had reached — and apply_update reported ok:true over
        # it. Staged with copytree raising ENOSPC for `client`: `ok=True`, the failure only
        # a tail on the success message, `client/` gone, and the next update check answering
        # "up to date" because the engine had already been bumped. On a real full disk the
        # damage is a truncated file rather than a vanished folder, and the window is only
        # as wide as the panel's net growth for that release — about 50 KB — but the outcome
        # is the same: a success banner over a panel that will never be repaired.
        #
        # So the new copy is built beside the live one and swapped in with a rename, which
        # either happens or does not. The live folder is only ever MOVED, never rmtree'd, so
        # there is no point at which a half-copy has replaced a working panel. Directories
        # are still replaced rather than merged, so a file deleted upstream really goes.
        def scrub(p: Path) -> None:
            """Remove a staging name whether it ended up a directory or a file."""
            shutil.rmtree(p, ignore_errors=True)
            try:
                if p.is_file():
                    p.unlink()
            except OSError:
                pass

        for part in PANEL_PARTS:
            s = src / part
            if not s.exists():
                continue
            d = dest / part
            staged = dest / (part + ".new")
            previous = dest / (part + ".old")
            scrub(staged)
            scrub(previous)
            try:
                if s.is_dir():
                    shutil.copytree(s, staged)  # may fail; nothing live has been touched
                else:
                    staged.write_bytes(s.read_bytes())
                moved_aside = False
                if d.exists():
                    # os.replace refuses to land on a non-empty directory, so the live copy
                    # goes aside first. The gap between the two renames is two metadata
                    # operations wide, against a whole copytree before.
                    os.replace(d, previous)
                    moved_aside = True
                try:
                    os.replace(staged, d)
                except Exception:
                    if moved_aside and not d.exists():
                        os.replace(previous, d)   # put the working panel back
                    raise
            except Exception:
                # A half-copy left in Adobe's folder is dead weight, and the failure this
                # is most likely recovering from is a disk with no room on it.
                scrub(staged)
                raise
            finally:
                scrub(previous)
            if progress:
                progress(f"panel: {part}")
    except Exception as e:
        return False, f"panel copied into {dest} failed: {e}"
    return True, f"panel updated in {dest} — restart Premiere to load it"
UPDATE_TIMEOUT = 15


def _update_urls(rel: str) -> list[str]:
    """Where to read a released file from, API first — and why not raw first.

    raw.githubusercontent sits behind a CDN with max-age=300. Publish a release and the
    check keeps reading the OLD version for up to five minutes: equal to what is
    installed, so no update is offered and nothing reports an error anywhere. The
    contents API answers from the repository itself and is correct immediately;
    `Accept: application/vnd.github.raw` returns the bytes rather than base64.

    raw stays as the fallback for when the API refuses — unauthenticated calls are capped
    at 60 an hour per address, and a shared office connection can reach that. A late
    update is worth more than no update.
    """
    # Percent-encode each segment but keep the slashes: one of the released files is
    # "Open xmlcut GUI.command", and an unencoded space makes urllib refuse the URL
    # outright ("URL can't contain control characters").
    safe = urllib.parse.quote(rel)
    return [
        f"https://api.github.com/repos/{UPDATE_OWNER}/{UPDATE_REPO}/contents/{safe}"
        f"?ref={UPDATE_BRANCH}",
        f"https://raw.githubusercontent.com/{UPDATE_OWNER}/{UPDATE_REPO}/"
        f"{UPDATE_BRANCH}/{safe}",
    ]


def _fetch(rel: str) -> bytes:
    import urllib.request
    last = None
    for i, url in enumerate(_update_urls(rel)):
        req = urllib.request.Request(url, headers={
            "User-Agent": f"xmlcut/{VERSION}",
            **({"Accept": "application/vnd.github.raw"} if i == 0 else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=UPDATE_TIMEOUT) as r:
                # One byte past the cap, so an oversized body is detected rather than
                # silently truncated into a file that would then fail to parse.
                data = r.read(MAX_UPDATE_BYTES + 1)
                declared = r.headers.get("Content-Length")
            if len(data) > MAX_UPDATE_BYTES:
                raise RuntimeError(
                    f"{rel} is larger than {MAX_UPDATE_BYTES // (1024 * 1024)} MB")
            # ⚠️ A SHORT BODY USED TO BE ACCEPTED AS THE WHOLE FILE. `read(amt)` goes
            # through readinto(), which simply returns fewer bytes when the stream ends
            # early — http.client only raises IncompleteRead from read() with NO amount,
            # and the ragged-EOF that a bare FIN produces is suppressed by default. Staged
            # against a server declaring Content-Length 1000 and sending 500: _fetch
            # returned 500 bytes, no exception. A truncated panel file then installed with
            # ok:true. A stalled or reset socket does NOT do this — it times out or raises,
            # and always did; the shape that gets through is a short body closed cleanly,
            # which in practice means an intermediary (proxy, captive portal, CDN edge).
            #
            # Both release endpoints send Content-Length. When one does not (a chunked
            # response), there is nothing to compare and the per-file checks in
            # release_file_complaint() are what stands between this and the disk.
            if declared is not None:
                try:
                    want = int(declared)
                except ValueError:
                    want = -1
                if want >= 0 and len(data) != want:
                    raise RuntimeError(
                        f"{rel}: got {len(data)} of {want} bytes — the download was cut off")
            return data
        except Exception as e:      # noqa: BLE001 - any failure just tries the fallback
            last = e
    raise RuntimeError(f"could not read {rel}: {last}")


def version_key(v: str) -> tuple:
    return tuple(int(x) if x.isdigit() else 0 for x in str(v).split("."))


def install_dir() -> Path:
    return Path(__file__).resolve().parent


def fetch_latest() -> "tuple[Optional[dict], Optional[str]]":
    """(latest.json, None) or (None, why it could not be read). Never raises.

    Two outcomes that must NOT be conflated: "nothing newer is published" and "the
    release channel could not be reached". check_update() returned None for both, so with
    the network down `--check-update-json` printed exactly what being current prints —
    measured, byte for byte — and the panel told the user "up to date, nothing newer
    published", which it had no basis for saying.

    Also the only place that checks latest.json is a JSON *object*. It wasn't, and a
    `latest.json` holding an array raised AttributeError straight out of the CLI.
    """
    try:
        raw = _fetch("latest.json")
    except Exception as e:
        return None, f"could not reach the release channel ({e})"
    try:
        info = json.loads(raw.decode("utf-8"))
    except Exception as e:
        return None, f"latest.json is not readable JSON ({e})"
    if not isinstance(info, dict):
        return None, "latest.json is not a JSON object"
    return info, None


def panel_repair_pending(here: Optional[Path] = None) -> Optional[str]:
    """The version whose panel copy did not finish, if the last update left one behind.

    Written beside the running xmlcut.py — which for the copy the panel runs is the
    extension's own lib/ — so the answer travels with the installation it describes.
    """
    try:
        return ((here or install_dir()) / PANEL_REPAIR_MARKER).read_text().strip() or None
    except OSError:
        return None


def set_panel_repair(here: Path, version: Optional[str]) -> None:
    """Record, or clear, that this installation's panel needs the copy step run again."""
    marker = here / PANEL_REPAIR_MARKER
    try:
        if version:
            marker.write_text(str(version))
        elif marker.exists():
            marker.unlink()
    except OSError:
        pass          # a marker we cannot write is not worth failing an update over


def newer_than_running(info: Optional[dict]) -> Optional[dict]:
    """`info` if it names a version above this one — or the SAME one, after a failed panel.

    ⚠️ A FAILED PANEL COPY USED TO END THE STORY. The engine is written before the panel is
    copied and a panel failure deliberately does not roll that back (the tool itself is
    correct), so the running VERSION already equalled latest.json's and every later check
    — the panel's, the CLI's — answered "up to date" while the panel sat broken. Measured
    on both staged failures: `next check: engine 3.71 vs channel 3.71 -> nothing offered`.
    Nothing would ever offer to fix it and nothing told the user to re-run the installer.

    The marker only makes the SAME version offerable again, which re-runs the download and
    the copy — it does not touch the ruling that the engine stays updated. A version that
    is genuinely behind is offered exactly as before.
    """
    if not info:
        return None
    v = str(info.get("version", "0"))
    if version_key(v) > version_key(VERSION):
        return info
    if v == VERSION and panel_repair_pending() == VERSION:
        return info
    return None


def check_update() -> Optional[dict]:
    """latest.json if it names a newer version, else None. Never raises.

    Kept for callers that only care whether there is something to install. Anything that
    reports to a human should use fetch_latest() so a failed check can be said out loud.
    """
    info, _err = fetch_latest()
    return newer_than_running(info)


def strip_trailing_comments(data: bytes) -> bytes:
    """`data` with trailing whitespace and any comments after the last statement removed.

    Only used to ask what a JS/JSX/CSS file's last real character is. Backwards from the
    end, so a `/*` found by rfind cannot be one quoted inside earlier code that still has
    live statements after it; each pass has to shorten the string, which is what makes the
    loop terminate.
    """
    tail = data.rstrip()
    while True:
        if tail.endswith(b"*/"):
            cut = tail.rfind(b"/*")
            if cut < 0:
                return tail
            tail = tail[:cut].rstrip()
            continue
        line_start = tail.rfind(b"\n") + 1
        if tail[line_start:].lstrip().startswith(b"//"):
            tail = tail[:line_start].rstrip()
            continue
        return tail


def release_file_complaint(rel: str, data: bytes) -> Optional[str]:
    """Why these bytes are not a whole released file, or None if they look like one.

    ⚠️ ONLY .py FILES WERE EVER CHECKED. apply_update compiled the Python and stored
    everything else exactly as it arrived, so a half main.js went to disk and into Adobe's
    extension folder with `ok: true`. Staged with _fetch handing back the first 200000 of
    434713 bytes: the update reported `updated 3.70 → 3.71 … panel updated`, the installed
    main.js was 200000 bytes, `node --check` on it failed with `SyntaxError: missing )
    after argument list` at line 3636, and — because the engine had been written at the
    same time and now reported the new number — the next check answered "up to date"
    forever. Only re-running the installer repairs that, and nothing says so.

    So every file is checked, and the whole update is refused rather than one bad file
    written. The checks are structural and deliberately dull, because a validator that
    rejects a GOOD release breaks seven machines at once, which is worse than what it is
    guarding against:

      * a floor no released file can be under (MIN_RELEASE_BYTES)
      * XML has to parse — the manifest CEP reads, and the .debug port file
      * HTML has to carry its closing tag
      * JS / JSX / CSS have to end on `;` or `}` once trailing comments are taken off.
        Measured on all five shipped files: every one of them does, and the 200000-byte
        truncation above ends mid-identifier on `s`. Shell launchers are exempt — they
        legitimately end on `fi` or `echo`.

    The comment stripping is not a nicety: the first cut of this check refused a main.js
    with `/* 3.71 marker */` appended, which is a perfectly whole file. A validator that
    can refuse a good release is worse than the truncation it is guarding against, so
    anything ambiguous is allowed through and left to the length check.

    tests/check_delivery.py runs this over every file in UPDATE_FILES as it stands in the
    repository, so a release that changes one of those endings fails there — before it is
    published — rather than on someone's machine.
    """
    if len(data) < MIN_RELEASE_BYTES:
        return f"only {len(data)} bytes — that is not the whole file"

    if rel.endswith(".py"):
        try:
            compile(data.decode("utf-8"), rel, "exec")
        except (SyntaxError, UnicodeDecodeError) as e:
            return f"did not parse ({e})"
        return None

    # `.debug` has no .xml suffix but is XML, and it is the file that decides whether the
    # panel can be debugged at all, so it is sniffed rather than named.
    if rel.endswith(".xml") or data[:5].lower() == b"<?xml":
        try:
            ET.fromstring(data.decode("utf-8"))
        except (ET.ParseError, UnicodeDecodeError) as e:
            return f"is not readable XML ({e})"
        return None

    if rel.endswith(".html"):
        if b"</html>" not in data.lower():
            return "has no closing </html> — the download was cut off"
        return None

    if rel.endswith((".js", ".jsx", ".css")):
        tail = strip_trailing_comments(data)
        if tail and not tail.endswith((b";", b"}")):
            return (f"ends on {tail[-24:]!r} rather than a finished statement — "
                    f"the download was cut off")
        # ⚠️ THE LAST CHARACTER IS NOT ENOUGH, AND THE SUITE FOUND THAT OUT BY ACCIDENT.
        # The ending test only asks what the file stops ON, so a cut that happens to land
        # just after a `}` — in the indentation of the next line, say — reads as finished.
        # Measured on this very file: the 200000-byte truncation this check was written for
        # used to end mid-identifier and was caught; after some lines were added upstream
        # the same cut landed in whitespace after a closing brace and sailed through. The
        # truncation had not become safer; the fixture had become lucky.
        #
        # Bracket balance is the structural fact a truncation cannot fake. Measured across
        # every shipped .js/.jsx/.css: all four are exactly balanced, and every truncation
        # of main.js at 50k, 100k, 200k, 300k and 400k is not — including the two the
        # ending test missed. Counted naively, braces in strings and comments included,
        # which is the risk: a future file could carry an unbalanced brace in a string and
        # be refused while whole. That is why tests/check_delivery.py runs this over every
        # file in UPDATE_FILES as it stands in the repository — an edit that unbalances one
        # fails there, before it is published, rather than on seven machines at once.
        text = data.decode("utf-8", "replace")
        for opener, closer, what in (("{", "}", "brace"), ("(", ")", "bracket"),
                                     ("[", "]", "square bracket")):
            delta = text.count(opener) - text.count(closer)
            if delta:
                return (f"has {abs(delta)} unclosed {what}(s) — the download was cut off"
                        if delta > 0 else
                        f"has {abs(delta)} more closing than opening {what}(s) — "
                        f"the file is damaged")
        return None

    return None


# ⚠️ 3.93 AUDIT · FROM THIS RELEASE ON, latest.json CARRIES A sha256 FOR EVERY FILE, and an
# updater that finds none refuses the release rather than installing files it cannot check.
# Publish Update.command writes the map over the exact bytes it pushes (every UPDATE_FILES
# entry: host.jsx, the CSS, the HTML and the tools carry no version of their own, so without
# it a stale CDN copy of any of them installed as this release). A release numbered below this
# was published before the map existed and keeps the two stamps only (release_file_stale).
# Engines before 3.93 never read the key: they take "version", "files" and "notes" as always,
# so a channel that carries it installs on them exactly as before (tests/check_update.py
# drives the 3.92 engine against it).
SHA256_REQUIRED_FROM = "3.93"
_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")


def release_digest_complaint(info: dict, files: list) -> Optional[str]:
    """Why this latest.json cannot be installed for want of per-file digests, or None.

    Asked before anything is downloaded. A release numbered below SHA256_REQUIRED_FROM needs
    none; from it on, latest.json must carry `"sha256"` naming a digest for every file this
    copy would fetch."""
    want = str(info.get("version") or "")
    if version_key(want) < version_key(SHA256_REQUIRED_FROM):
        return None
    digests = info.get("sha256")
    if not isinstance(digests, dict) or not digests:
        return (f"latest.json for {want} carries no sha256 for its files, which every release "
                f"from {SHA256_REQUIRED_FROM} on is published with, so what it would download "
                f"cannot be checked")
    missing = [rel for rel in files
               if not isinstance(digests.get(rel), str) or not _SHA256_RE.fullmatch(digests[rel])]
    if missing:
        return (f"latest.json for {want} has no sha256 for "
                + ", ".join(missing[:3]) + (f" and {len(missing) - 3} more" if len(missing) > 3
                                            else "")
                + (", so it cannot be checked" if len(missing) == 1
                   else ", so they cannot be checked"))
    return None


def release_file_stale(rel: str, data: bytes, info: dict) -> Optional[str]:
    """Why these bytes are not THIS release's copy of `rel`, or None.

    Two stamps Publish Update.command puts in every release, checked because they cost
    nothing and a stale CDN copy of the previous release fails them: the CEP manifest's
    ExtensionBundleVersion (set_version writes it from the same number as VERSION) and the
    CHANGELOG entry for the version in main.js (check_publishable refuses a release without
    one). Every other file carries no version of its own, so for them — and for these two as
    well — a latest.json that carries `"sha256": {"<file>": "<hex>"}` is checked file by
    file. From SHA256_REQUIRED_FROM on the map is required (release_digest_complaint refuses
    a release without it before anything is fetched); a release numbered below that gets the
    stamps only. A map that names no digest for a file is a refusal, not a pass.
    """
    want = str(info.get("version") or "")
    # The two stamps first, because what they say is more use to the person reading it than
    # "the digest differs" — they name the release the file came from. Both still have to
    # pass the digest after them.
    if rel == "panel/CSXS/manifest.xml":
        try:
            got = ET.fromstring(data.decode("utf-8")).get("ExtensionBundleVersion") or ""
        except (ET.ParseError, UnicodeDecodeError):
            got = ""
        if got != want:
            return (f"is from release {got or '(no version)'}, not {want}")
    if rel == "panel/client/main.js":
        if not re.search(r'^\s*"%s"\s*:\s*CL_' % re.escape(want),
                         data.decode("utf-8", "replace"), re.M):
            return f"has no release notes for {want}, so it is not {want}'s panel"
    digests = info.get("sha256")
    if isinstance(digests, dict):
        d = digests.get(rel)
        if not isinstance(d, str) or not _SHA256_RE.fullmatch(d):
            return "has no sha256 in latest.json to be checked against"
        if hashlib.sha256(data).hexdigest() != d.lower():
            return "is not the file this release published (its sha256 differs)"
    return None


def apply_update(info: dict, progress=None, out: Optional[dict] = None) -> tuple[bool, str]:
    """Download the released files and swap them in, or change nothing at all.

    Every file is fetched and validated BEFORE anything on disk is touched, because a
    half-written update is worse than no update: a truncated .py leaves a tool that will
    not start. Python files are compiled to prove they parse, and the new xmlcut.py must
    report the version latest.json promised — that catches a publish where the files and
    the version number disagree.

    `progress` is called with a short human string at each step, so a caller can show what
    is happening rather than leaving a dead button. Four files over an office connection is
    long enough that silence reads as a hang.
    """
    def say(msg: str) -> None:
        if progress:
            progress(msg)

    here = install_dir()
    if (here / ".git").exists():
        return False, ("this is the source checkout, not an installed copy — "
                       "use `git pull` instead")

    # latest.json lists plain filenames; the remote copy of each lives under UPDATE_DIR
    # and lands back beside xmlcut.py under its own name.
    #
    # When the running copy is the one bundled inside the panel, "beside xmlcut.py" is
    # Adobe's extensions folder — so only the files the panel actually runs are fetched.
    # Everything else (the browser GUI, its launcher, the README) belongs beside a user's
    # own copy, and writing it in here built a second installation nothing launches.
    bundled = is_bundled_install(here)
    wanted = info.get("files") or UPDATE_FILES
    if bundled:
        wanted = [f for f in wanted
                  if str(f) == "xmlcut.py"
                  or str(f).startswith("panel/") or str(f).startswith("tools/")]
        say("Updating the copy inside the Premiere panel")
    files = []
    for f in wanted:
        rel = safe_rel(str(f))
        if rel is None:
            return False, (f"latest.json names a file this updater will not write "
                           f"({f!r}) — nothing was changed")
        files.append(rel)
    if not files:
        return False, "latest.json listed nothing this copy can update — nothing was changed"
    # Before the first download: a release that should carry digests and does not is refused
    # whole, not file by file halfway down the list.
    no_digests = release_digest_complaint(info, files)
    if no_digests:
        return False, (f"{no_digests} — nothing was changed. The release has to be published "
                       f"again with Publish Update.command, which writes them")
    got: dict[str, bytes] = {}
    for n, rel in enumerate(files, start=1):
        say(f"Downloading {rel} ({n}/{len(files)})")
        try:
            data = _fetch(f"{UPDATE_DIR}/{rel}")
        except Exception as e:
            return False, f"download failed ({rel}): {e} — nothing was changed"
        if not data:
            return False, f"{rel} came back empty — nothing was changed"
        # EVERY file, not only the Python. A half main.js used to sail through here and
        # into Adobe's extension folder; see release_file_complaint() for the measurement.
        complaint = release_file_complaint(rel, data)
        if complaint:
            return False, f"{rel} {complaint} — nothing was changed"
        # NOTE: this catches a publish whose files and version disagree, but it
        # cannot catch one version published twice with different bytes — both
        # copies report the same number. That is why Publish Update.command bumps
        # rather than reusing a number; see the --same warning there.
        if rel == "xmlcut.py":
            m = re.search(r'VERSION\s*=\s*"([^"]+)"', data.decode("utf-8"))
            if not m or m.group(1) != info.get("version"):
                return False, (f"the download says "
                               f"{m.group(1) if m else 'no version'}, not "
                               f"{info.get('version')} — nothing was changed")
        # ⚠️ 3.93 AUDIT · AND THE PANEL FILES HAVE TO BE FROM THIS RELEASE TOO. Each file is
        # fetched on its own, API first, then raw.githubusercontent — whose CDN edge can
        # still hold the PREVIOUS release for five minutes after a publish. MEASURED on
        # 3.93 (stubbed channel): latest.json and xmlcut.py from the new release, every
        # panel file from the old one -> `ok: True`, `restart_needed: False` ("cut engine
        # only, already live"), the header on the new number, and every later check "up to
        # date" — the panel fix never lands. The xmlcut.py VERSION check above was the only
        # one. See release_file_stale() for the two stamps every release carries, and the
        # per-file digests a latest.json may carry.
        stale = release_file_stale(rel, data, info)
        if stale:
            return False, (f"{rel} {stale} — nothing was changed; the release channel may "
                           f"still be serving the previous release's copy, so try again in "
                           f"a few minutes")
        got[rel] = data

    # Which files this update actually CHANGES, as opposed to rewriting identically.
    #
    # latest.json always lists the whole set, so "panel files were in the release" is not the
    # same as "the panel changed". A release that only touches the cut logic needs no
    # Premiere restart at all — the engine is spawned fresh for every export — and saying
    # "quit and reopen" every time trains people to ignore it on the one occasion it matters.
    ext_dest = cep_extensions_dir() / PANEL_ID

    def current_bytes(rel: str) -> Optional[bytes]:
        """What is on disk now, at the place this file actually lives.

        For a BUNDLED install the installed panel is in the extension ROOT — `here/panel/`
        is only a staging directory, and it is deleted after every update. Comparing against
        it made all nine panel files look changed on every release, so an engine-only
        release still demanded a restart.
        """
        cands = [here / rel]
        if bundled and rel.startswith("panel/"):
            cands.insert(0, ext_dest / rel[len("panel/"):])
        for p in cands:
            try:
                if p.is_file():
                    return p.read_bytes()
            except OSError:
                pass
        return None

    changed = [rel for rel, data in got.items() if current_bytes(rel) != data]

    say("Backing up the current version")
    backup = here / ".backup"
    saved: list[str] = []
    # Files this update CREATES rather than replaces. A rollback restored the ones that
    # existed and left every new one in place — on a first update from a copy that predates
    # the panel, that is the whole panel/ tree surviving a failed install.
    fresh: list[str] = []
    try:
        shutil.rmtree(backup, ignore_errors=True)
        for rel in files:
            src = here / rel
            if src.exists():
                dst = backup / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(src.read_bytes())
                saved.append(rel)
            else:
                fresh.append(rel)
    except Exception as e:
        return False, f"couldn't back up the current version ({e}) — nothing was changed"

    say(f"Installing {info['version']}")
    try:
        for rel, data in got.items():
            target = here / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            if target.suffix == ".command":
                target.chmod(0o755)      # a downloaded launcher must stay double-clickable
    except Exception as e:
        for rel in saved:                # put it back exactly as it was
            try:
                (here / rel).write_bytes((backup / rel).read_bytes())
            except Exception:
                pass
        for rel in fresh:                # and leave nothing behind that wasn't there
            try:
                (here / rel).unlink()
            except Exception:
                pass
        return False, f"update failed ({e}) — rolled back, still on {VERSION}"

    # The panel lives in Adobe's extensions folder, not here, so refreshing the files
    # above is only half of it. Done last, and a failure here does not roll the update
    # back: the tool itself is already correctly updated.
    tail = ""
    panel_error = None
    if any(rel.startswith("panel/") for rel in files):
        ok, msg = reinstall_panel(here, progress)
        tail = ("\n" + ("Premiere panel: " + msg if ok
                        else "the tool updated, but the panel did not: " + msg))
        # ⚠️ A FAILED PANEL COPY HAS TO STAY ASKABLE. The engine is not rolled back — it is
        # correct, and that ruling stands — but the version number it now reports is what
        # made every later check answer "up to date" over a panel that never arrived. The
        # marker is the one thing that keeps the same release offerable until the copy
        # actually lands; reinstall_panel succeeding is what takes it away again.
        set_panel_repair(here, None if ok else info.get("version"))
        if not ok:
            panel_error = msg
        # For a bundled install, here/panel was only ever a staging area — the copy
        # Premiere loads now sits in the extension root. Leaving it behind meant a second
        # panel/ tree accumulating inside Adobe's folder on every update.
        if ok and bundled:
            shutil.rmtree(here / "panel", ignore_errors=True)

    # Reported through `out` rather than by widening the return: there are ten early
    # `return False, msg` paths in here and changing their arity would be pure risk.
    if out is not None:
        # Premiere loads the panel's manifest, HTML, JS and JSX ONCE, at launch. Only a
        # change to one of those needs a restart — not the installer scripts, and not the
        # engine, which is a subprocess started fresh for every export.
        loaded = tuple(f"panel/{p}" for p in PANEL_PARTS)
        out["changed"] = sorted(changed)
        out["restart_needed"] = any(r.startswith(loaded) for r in changed)
        # The one fact a caller must not have to parse out of the message: the engine is
        # new, the panel is not. A front end that reads this can say so where the success
        # banner is, instead of in a log.
        out["panel_error"] = panel_error
    # ⚠️ 3.93 AUDIT · SAID AS IT IS. In the panel's own (bundled) install the panel files
    # arrive in a staging folder that did not exist before, so they are "fresh", never backed
    # up, and the swap removes its .old copies — .backup holds the engine and its tools only.
    # "The previous version is in .backup" sent someone rolling back a bad panel release to a
    # folder without it (and restoring the engine alone from there is a mixed install).
    kept = ("The previous engine is in .backup (the panel's own files are replaced, not "
            "kept)." if bundled else "The previous version is in .backup.")
    return True, (f"updated {VERSION} → {info['version']}. {kept}" + tail)


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def txt(node: Optional[ET.Element], path: str, default: str = "") -> str:
    if node is None:
        return default
    found = node.find(path)
    if found is None or found.text is None:
        return default
    return found.text.strip()


def num(node: Optional[ET.Element], path: str, default: Optional[float] = None) -> Optional[float]:
    raw = txt(node, path)
    if raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def parse_rate(rate_node: Optional[ET.Element], fallback: float = 25.0) -> float:
    """FCP7 <rate><timebase>N</timebase><ntsc>TRUE|FALSE</ntsc></rate>."""
    if rate_node is None:
        return fallback
    timebase = num(rate_node, "timebase")
    if timebase is None:
        return fallback
    ntsc = txt(rate_node, "ntsc").upper() == "TRUE"
    return timebase * 1000.0 / 1001.0 if ntsc else float(timebase)


def pathurl_to_path(pathurl: str) -> str:
    """file://localhost/Volumes/Media/A%20Clip.mp4 -> /Volumes/Media/A Clip.mp4"""
    if not pathurl:
        return ""
    p = urllib.parse.unquote(pathurl.strip())
    for prefix in ("file://localhost", "file://", "file:"):
        if p.startswith(prefix):
            p = p[len(prefix):]
            break
    # Windows exports look like /C:/Footage/...
    if re.match(r"^/[A-Za-z]:", p):
        p = p[1:]
    return p


def frames_to_tc(frames: float, fps: float) -> str:
    """Non-drop timecode HH:MM:SS:FF."""
    if fps <= 0:
        return "00:00:00:00"
    f = int(round(frames))
    fps_i = int(round(fps))
    h, rem = divmod(f, fps_i * 3600)
    m, rem = divmod(rem, fps_i * 60)
    s, ff = divmod(rem, fps_i)
    return f"{h:02d}:{m:02d}:{s:02d}:{ff:02d}"


def frames_to_seconds(frames: float, fps: float) -> float:
    return frames / fps if fps > 0 else 0.0


MIN_USABLE_FPS = 1.0


def usable_fps(value) -> float:
    """A frame rate you can divide by, or 0.0.

    Premiere reports a frame rate around 1e-7 for nested sequences, stills, audio and
    Dynamic Link comps — 25 of 94 clips on a real timeline. That survives a `> 0` test,
    then rounds to 0 inside frames_to_tc and divides by zero, and makes
    `abs(interpreted - actual) / interpreted` astronomically large so every such clip
    gets reported as reinterpreted footage.

    Nothing below 1 fps is a real video rate. One definition, used everywhere, so the
    two call sites cannot drift apart again.
    """
    if not isinstance(value, (int, float)):
        return 0.0
    v = float(value)
    return v if v >= MIN_USABLE_FPS else 0.0


def is_retimed(speed_percent: float) -> bool:
    """True when a clip is not at 100%.

    A tolerance, not `not in (0, 100)`. A tick-derived speed need not land exactly on
    100.0, and this decides whether build_command takes the retime branch — so an
    unlucky 100.0000001 would otherwise resample a clip that needed nothing done.
    """
    return bool(speed_percent) and abs(speed_percent - 100.0) > 0.01


def consumed_frames(in_seconds: float, dur_seconds: float, fps: float) -> int:
    """How many source frames lie in [in, in+dur) at `fps`.

    Deliberately NOT round(dur * fps). Frames sit at k/fps, and a tick-derived
    in-point almost never lands on one, so the count depends on WHERE the range
    starts as well as how long it is: 1.3s at 24 fps holds 32 frames from 3.000s
    but 31 from 3.020s. Rounding the duration alone is a frame out whenever the two
    ends straddle their boundaries differently — measured on a real timeline, that
    was 5 of 16 cuts, each 42 ms wrong.

    This is the value -frames:v pins, so an error here is an error in the file.

    The epsilon is in FRAMES, matching the seek tolerance in build_command: a hair
    over a boundary must not promote to the next frame, but a genuinely mid-frame
    edge still rounds up.
    """
    if fps <= 0:
        return 0
    e = 1e-4
    n = (math.ceil((in_seconds + dur_seconds) * fps - e)
         - math.ceil(in_seconds * fps - e))
    return max(1, n)


def read_timeremap(clip: ET.Element) -> tuple[float, bool, bool, str, list]:
    """Pull speed / reverse / ramp info out of a clipitem's filters.

    Returns (speed_percent, reversed, varies, span, other_filter_names).

    Premiere records a reverse in two ways depending on version — a negative speed,
    or a `reverse` parameter set to TRUE — so both are accepted and normalised to a
    positive speed plus a reversed flag. A KEYFRAMED ramp is detected but not
    followed: only one representative speed is returned, with `varies` set so the
    caller can say so out loud rather than quietly pretending it was constant.
    """
    speed = 100.0
    reverse = False
    kf_values: list[float] = []
    others: list = []

    for filt in clip.findall("filter"):
        eid = txt(filt, "effect/effectid")
        ename = txt(filt, "effect/name")
        if eid == "timeremap":
            for p in filt.findall("effect/parameter"):
                pid = txt(p, "parameterid")
                if pid == "speed":
                    v = num(p, "value", None)
                    if v is not None:
                        speed = v
                    for kf in p.findall("keyframe"):
                        kv = num(kf, "value", None)
                        if kv is not None:
                            kf_values.append(kv)
                elif pid == "reverse":
                    reverse = txt(p, "value").upper() == "TRUE"
        elif ename or eid:
            others.append(ename or eid)

    if kf_values and speed == 100.0:
        speed = kf_values[0]           # no flat <value>; take the ramp's first key
    if speed < 0:
        reverse, speed = True, abs(speed)

    distinct = sorted({round(abs(v), 3) for v in kf_values})
    varies = len(distinct) > 1
    span = f"{distinct[0]:g}–{distinct[-1]:g}%" if varies else ""
    return (speed or 100.0), reverse, varies, span, others


# Premiere's clip Audio Gain, as the export's <effectid> spells it (FourCC 'aufx' 'Gain'
# 'KeyG' in hex), lower-cased for the comparison. See read_audio_level.
AUDIO_GAIN_EFFECTID = "{61756678, 4761696e, 4b657947}"


def read_audio_level(node: ET.Element) -> tuple[float, bool]:
    """The Audio Levels fader Premiere wrote on this clipitem or track, as a LINEAR ratio.

    Returns (level, keyframed). 1.0 — unity, 0 dB — when there is no such filter, which is
    what an untouched clip looks like, so a timeline nobody rode the faders on is unchanged.

    ⚠️ THIS IS THE MIX, AND NOTHING READ IT UNTIL NOW. `<effectid>audiolevels</effectid>`
    with `<parameterid>level</parameterid>` is where every fader move on a clip and every
    track fader ends up in the XML, and _timeline_audio.mp3 summed every part at unity
    through amix(normalize=0) regardless. MEASURED on 61 real exports (46 of them distinct):
    436 clipitem levels and 163 track levels are NOT 1.0, spread over 53 files — so on this
    corpus the un-levelled mix is the normal case, not the corner case. On a controlled
    fixture whose two tones are normalised to an identical peak (voice mono at 1.0, bed
    stereo at 0.25) the delivered mp3 put the bed 3.10 dB ABOVE the voice where Premiere has
    it 12.04 dB below: 15.14 dB of inverted balance.

    Values run either side of unity — the measured corpus holds 0.1408 (-17.0 dB) through
    3.5398 (+11.0 dB) — so this both attenuates and boosts, and a make-up stage has to
    expect both.

    A KEYFRAMED fader is reduced to its FIRST key and reported, exactly as read_timeremap
    does with a speed ramp: following the curve means writing a volume expression per part
    and getting it subtly wrong is worse than a documented approximation. 6 of the corpus's
    599 level parameters are keyframed. Note the `<value>` beside the keyframes is NOT the
    first key (measured: value 1 with keys 0.561226 then 1), so the keys win when present.

    ⚠️ AND PREMIERE'S CLIP "AUDIO GAIN" IS A SECOND FILTER, multiplied in. Audio Gain (the
    G key) is not a fader move: the export writes it as its own effect, `<name>Gain</name>`,
    effectid `{61756678, 4761696e, 4b657947}`, parameter `Gain(dB)` in DECIBELS — and this
    function used to skip it, so every gained clip reached the mix at its un-gained level
    while the manifest said levels_applied. MEASURED on a fixture: a -12 dB Gain on A2 put
    it 0.0 dB against A1 in the mix instead of -12; on a real export four of these sit on one
    SFX (+4 dB), and its stretch of _track_A3.mp3 read -30.1 dB before and -26.1 after.
    Premiere applies the two in series, so the linear product is what reaches the track —
    Gain +4 with Levels 0.5 is -2.02 dB. A keyframed Gain is reduced to its first key and
    flagged, exactly like the fader.
    """
    level, varies, found = 1.0, False, False
    for filt in node.findall("filter"):
        eff = filt.find("effect")
        if eff is None:
            continue
        eid = txt(eff, "effectid").strip().lower()
        ename = txt(eff, "name").strip().lower().replace(" ", "")
        if eid == "audiolevels" or ename == "audiolevels":
            if found:
                continue            # the first Audio Levels wins, as it always has
            for p in eff.findall("parameter"):
                if txt(p, "parameterid").strip().lower() != "level":
                    continue
                keys = [num(kf, "value", None) for kf in p.findall("keyframe")]
                keys = [k for k in keys if k is not None]
                if keys:
                    level *= max(0.0, float(keys[0]))
                    varies = varies or len({round(abs(k), 6) for k in keys}) > 1
                    found = True
                    break
                v = num(p, "value", None)
                if v is not None:
                    level *= max(0.0, float(v))
                    found = True
                    break
        elif eid == AUDIO_GAIN_EFFECTID or ename == "gain":
            for p in eff.findall("parameter"):
                if txt(p, "parameterid").strip().lower() != "gain(db)":
                    continue
                keys = [num(kf, "value", None) for kf in p.findall("keyframe")]
                keys = [k for k in keys if k is not None]
                db = keys[0] if keys else num(p, "value", None)
                if db is not None:
                    level *= 10.0 ** (float(db) / 20.0)
                    varies = varies or len({round(k, 6) for k in keys}) > 1
                break
    return level, varies


def audio_fade_curve(name: str) -> str:
    """The afade curve for one of Premiere's audio transitions, by the name the export gives.

    FCP7 XML spells Premiere's three as "Cross Fade (+3dB)" (Constant Power — Premiere's
    default, an equal-power sine/cosine pair: afade's `qsin`), "Cross Fade (0dB)" (Constant
    Gain — linear: `tri`) and "Exponential Fade". The last is mapped to `exp`, which is an
    ASSUMPTION: its exact shape was not measured against Premiere. Anything unrecognised
    gets the default transition's curve rather than no fade at all.
    """
    n = (name or "").lower().replace(" ", "")
    if "exponential" in n:
        return "exp"
    if "0db" in n and "+3db" not in n or "constantgain" in n:
        return "tri"
    return "qsin"


def audio_fades_for(cut, transitions: list, seq_fps: float) -> list:
    """The fade-in and fade-out an audio clip gets from the <transitionitem>s on its track.

    ⚠️ AUDIO TRANSITIONS USED TO REACH ONLY THE CLIP EDGES, never the level. The mix placed
    each part at full fader level from its first sample to its last, so a music bed under an
    end-black fade played at full level to the last frame and stopped dead — MEASURED on a
    fixture, -15.6 dB mean in the last 0.26 s of a 2 s fade-out against a -15.3 body, and on
    a real export's music track the same: -23.7 dB half way through its 1 s end fade, louder
    than the body before it (-25.3). With the fades it reads -30.9 there.

    Premiere writes the transition as its own item on the track, and FCP7 marks the edge it
    defines with -1, which resolve_transition_edges has already filled in — so by here:

        start-black   the clip STARTS where the transition starts: fade in over it
        end-black     the clip ENDS where the transition ends: fade out over it
        a cross-fade  the outgoing clip runs on its handle to the transition's END and the
                      incoming one starts at its START, so both of them overlap it: the
                      first fades out and the second fades in across the same window

    One rule covers all three: a transition whose start is this clip's start fades it in, one
    whose end is this clip's end fades it out, within a frame. A transition that matches no
    clip edge (the edges were written explicitly, not as -1) is left unmarked, and the mix
    says how many of those it could not place rather than inventing a shape for them.

    Stored in SOURCE seconds, so a nest that trims or moves the clip carries its fades with
    it. A retimed or reversed clip is left out of the mix altogether, so it gets none — but
    its transitions are still CLAIMED: the note already names the clip as left out, and
    counting its fade again as "could not be tied to a clip edge" would misreport why
    (MEASURED on a real export, whose only such transition sat on a 71% SFX).
    """
    if seq_fps <= 0:
        return []
    retimed = abs((cut.speed_percent or 100.0) - 100.0) > 0.01 or cut.reversed
    t_in, t_out = cut.timeline_in_frames, cut.timeline_out_frames
    if t_out <= t_in:
        return []

    def src(frame):
        return (cut.source_in_seconds or 0.0) + (frame - t_in) / seq_fps

    out = []
    for tr in transitions:
        a = tr.get("alignment", "").strip().lower()
        lo, hi = max(tr["start"], t_in), min(tr["end"], t_out)
        if hi <= lo:
            continue
        if a != "end-black" and abs(tr["start"] - t_in) <= 1:
            out.append({"type": "in", "src_start": src(lo), "src_end": src(hi),
                        "curve": audio_fade_curve(tr.get("name", ""))})
            tr["claimed"] = True
        if a != "start-black" and abs(tr["end"] - t_out) <= 1:
            out.append({"type": "out", "src_start": src(lo), "src_end": src(hi),
                        "curve": audio_fade_curve(tr.get("name", ""))})
            tr["claimed"] = True
    return [] if retimed else out


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def fmt_secs(total: float) -> str:
    """Seconds and hundredths, zero-padded: 2.5 -> "02.50".

    The separator is a dot, not the colon you would write by hand: Finder still treats ':'
    in a filename as a path separator and displays it as '/', which would turn a tidy
    "(00.00-00.02)" into "(00/00-00/02)". A dot also keeps the hyphen free to mean one
    thing only — the gap between the two ends of the range.

    ⚠️ CLAMPED AT 00.00, AND THE CLAMP IS THE POINT. A clipitem whose in-point sits before
    its media begins has a NEGATIVE source in-point, and the old arithmetic put the sign on
    the hundredths instead of in front of the number:

        -0.40 -> "00.-40"      -0.01 -> "00.-1"      -1.50 -> "-1.-50"

    All three are malformed, and the middle one is not even the right width. Worse, they
    break the RANGE: the hyphen is what separates the two ends, so a shipped file called
    14_(00.-40-01.87)_131.mp4 has three plausible readings of where the clip starts.

    A filename is a LABEL and the manifest is the RECORD. Nothing downstream parses these
    digits back into a number — index_free() compares the stem as text, verify.py reads the
    manifest — so the label may safely say 00.00 for "starts at or before the first frame",
    while source_in_seconds in manifest.json/.csv keeps the true signed value (readable()
    rounds it to 6dp and changes nothing else). The information is not dropped, it is kept
    where something can act on it.

    Non-finite input is clamped the same way rather than raising: int(nan) is a ValueError,
    and a filename helper may not be able to kill a run that has already been costed.
    """
    if not (total > 0.0):                 # also catches nan, which fails every comparison
        total = 0.0
    elif total == float("inf"):
        total = 0.0
    whole = int(total)
    cs = int(round((total - whole) * 100))
    if cs >= 100:
        whole, cs = whole + 1, 0
    # Width 2 is a MINIMUM, not a cap: a source in-point 137 seconds into a file is
    # legitimately "137.42", and truncating it to two digits would make two different
    # ranges of the same file share a name.
    return f"{whole:02d}.{cs:02d}"


def secs_cs(frames: float, fps: float) -> str:
    """A frame position as seconds and hundredths: frame 60 at 24 fps -> "02.50".

    """
    return fmt_secs(frames / fps if fps > 0 else 0.0)


def tc_range(cut: "Cut", fps: float, cut_from: str = "source") -> str:
    """The clip's span, for the filename: "(03.93-05.06)".

    Inside its SOURCE FILE when the delivered pixels came out of that file — the filename
    already names the source, so the numbers beside it should locate the range in it.
    Timeline position is still in clips.csv and the manifest, where it belongs.

    TIMELINE position in the three cases where a source range is not a thing worth
    printing, because there is no source those numbers describe:

      A STILL. Its in/out are an arbitrary offset into a virtual 24-hour clip; only the
      time it spends on screen is real. (This case predates the other two.)

      RENDER MODE. `cut_from == "render"` means the pixels ARE the timeline — Premiere
      rendered the sequence and the engine cut ranges out of that. Naming those files after
      a position in a source file the frames never passed through is the reported bug:
      the timecode in edited filenames "không khớp hoàn toàn" with the timeline. It is not
      a rounding error — the two clocks are unrelated, and on a clip whose media starts at
      Premiere's 1-hour zero they differ by 3600 seconds.

      ANYTHING NOT DECODABLE AS A SOURCE — media_kind "unsupported": graphics (.mogrt,
      .aegraphic), Essential Graphics titles and adjustment layers (a <file> with no
      pathurl), synthetics (Black Video, a colour matte) and Dynamic Link comps. These
      inherit Premiere's virtual 24-hour clock, which is why one real export carried
      02_(3600.03-3600.63)_Graphic.mp4: 3600 s is 01:00:00:00, the start of that clock,
      not a position in anything.

    `cut_from` is passed down from assign_output_names rather than read off a module-level
    flag, so a single-cut rename inside run_cut names the file the same way the batch pass
    did — the two disagreeing is exactly the shape of bug that leaves a manifest naming
    files that are not in the folder.
    """
    if (cut.media_kind != "video" or cut_from == "render"
            or cut.source_duration_seconds <= 0):
        return (f"({secs_cs(cut.timeline_in_frames, fps)}"
                f"-{secs_cs(cut.timeline_out_frames, fps)})")
    start = cut.source_in_seconds
    return f"({fmt_secs(start)}-{fmt_secs(start + cut.source_duration_seconds)})"


def sanitize(name: str, maxlen: int = 60) -> str:
    # ⚠️ COMPOSED FIRST, OR EVERY VIETNAMESE ACCENT BECOMES AN UNDERSCORE. The same name
    # can arrive in two byte forms: NFC, where "ả" is one code point, and NFD, where it is
    # "a" followed by a COMBINING hook (U+0309). A combining mark is category Mn, which is
    # not \w, so the regex below replaced each one with "_". MEASURED on a pathurl carrying
    # the NFD form: "Cảnh quay khách hàng" was delivered as Ca_nh_quay_kha_ch_ha_ng, while
    # the NFC spelling of the same name came through intact. NFD is what HFS+ and some copy
    # and sync tools store on disk, and real NFD-named Vietnamese footage exists on the
    # machine this is used on.
    #
    # NFC rather than stripping the marks: stripping would turn "Cảnh" into "Canh", a
    # different word. And it makes the two forms produce ONE filename, not merely two
    # readable ones — a re-export has to land on the name the earlier run wrote. Every
    # Vietnamese letter has a precomposed form, so nothing of the name is lost.
    #
    # ⚠️ ONE-TIME COST ON A FOLDER CUT BEFORE THIS. Its manifest recorded the broken name,
    # and run_cut compares the recorded name with the one it is about to write, so a
    # --resume into it re-encodes that clip under the composed name. MEASURED: "1 written",
    # the Ca_nh_… file left in place, and the end-of-run stray advisory naming it. Only
    # clips whose source path was NFD are affected; an NFC path always gave this name.
    name = unicodedata.normalize("NFC", name)
    name = re.sub(r"[^\w\-. ]+", "_", name).strip().replace(" ", "_")
    name = re.sub(r"_+", "_", name)
    return name[:maxlen] or "clip"


# --------------------------------------------------------------------------
# data model
# --------------------------------------------------------------------------

@dataclass
class Cut:
    index: int = 0
    clip_name: str = ""
    track_type: str = "video"
    track_index: int = 1
    # ⚠️ A SEPARATE FIELD, NOT A REDEFINITION OF track_index. Premiere explodes one audio
    # track into one <track> per channel, so the XML's lane ordinal is not the A-number the
    # editor sees — the real export has 9 lanes for 4 tracks. But track_index feeds
    # render_name(), pick_key() and the panel's clipKey, and collapsing 9 lanes to 4 numbers
    # takes audio pick_keys from 21 distinct to 15: six collisions, where unticking one of
    # two identical-looking "Typewriter" rows would silently drop both. So the lane ordinal
    # stays in track_index and keeps owning the keys and filenames; premiere_track carries
    # the A-number that --audio-tracks and the panel menu speak in.
    premiere_track: int = 1

    # timeline position (sequence frame rate)
    timeline_in_frames: int = 0
    timeline_out_frames: int = 0
    timeline_in_tc: str = ""
    timeline_out_tc: str = ""

    # source range — ⚠️ TWO MEANINGS, BY PATH. From FCP7 XML these are the clipitem's own <in>/
    # <out>, which Premiere writes at the CLIP's rate (the sequence rate for a conformed
    # clip), and they are never touched by the whole-frame trim: they are the REQUEST as the
    # editor made it, and a clipitem that starts before its media keeps its negative here.
    # From a panel dump they are round(seconds × the file's rate). A reader that needs the
    # frame the delivered file actually starts on must use round(source_in_seconds ×
    # source_fps) — verify.py does — not this column: on a real 24-in-30 export it disagreed
    # with the delivered frame on 52 of 54 rows.
    source_in_frames: int = 0
    source_out_frames: int = 0
    source_in_tc: str = ""
    source_out_tc: str = ""
    source_in_seconds: float = 0.0
    source_duration_seconds: float = 0.0
    timing_source: str = "frames"     # "ticks" (exact) or "frames" (derived)

    duration_frames: int = 0          # length on the timeline
    duration_seconds: float = 0.0
    source_consumed_frames: int = 0   # source material used (differs when speed != 100)
    # Frames dropped by --whole-frames, and from which end. 0 when the range already landed on
    # frame boundaries, which is most cuts on most timelines.
    frames_trimmed: int = 0

    # ⚠️ HOW FAR THIS CUT REACHES PAST THE END OF ITS OWN MEDIA, in seconds, and how much of
    # that was given back. Premiere and the file disagree about how long the file is, and the
    # editor is not the one who got it wrong: MEASURED on a real phone clip, Premiere declares
    # 1913 frames where 1912 exist, so a clip dragged to the end of the footage — the ordinary
    # thing to do — asks for one frame that was never recorded. An mp3 in the same timeline was
    # declared 6.56 s and holds 4.36 s. Both then failed the delivered-count check with "the
    # source is shorter than the cut, or unreadable", which named neither the cause nor the fix.
    overhang_seconds: float = 0.0
    overhang_trimmed: bool = False

    # source media
    source_path: str = ""
    source_exists: bool = False
    file_id: str = ""

    # A pre-rendered TIMELINE RANGE for this cut, when --render-dir supplied one.
    # In render mode the cut is encoded from THIS instead of from source_path, which is
    # the whole point: Premiere has already baked in the colour, the titles, the Motion
    # and the speed ramp, none of which exist in the raw source file.
    #
    # Its dimensions and rate are the SEQUENCE's, not the source clip's — a 4K clip in a
    # 1080 sequence renders at 1080 — so they are probed and recorded separately rather
    # than being assumed to match the source. Everything downstream that needs to know
    # what ffmpeg will actually read goes through encode_input().
    render_path: str = ""
    render_frames: int = 0
    render_width: Optional[int] = None
    render_height: Optional[int] = None
    render_fps: float = 0.0
    render_codec: str = ""
    render_bitrate: Optional[int] = None
    # A render that came back LONGER than its cut, and what the pixels said about it.
    # render_overshoot is "" (no disagreement), "head", "tail" or "unclear"; head_trim is
    # how many frames the encode must drop off the front. Decided by resolve_render_
    # overshoot(), which measures rather than assumes — see its docstring.
    render_overshoot: str = ""
    render_head_trim: int = 0
    # False when render_frames came from the container's nb_frames; True when it had to be
    # guessed as duration x rate. The guess is fine for reporting a gross mismatch and is
    # not fit to decide an encode — see resolve_render_overshoot.
    render_frames_derived: bool = False
    # Why the overshoot could not be placed, when it could not. Empty unless the answer was
    # "unclear", and carried into the refusal so it names the real obstacle.
    render_overshoot_why: str = ""
    # This clip's position in the WHOLE timeline, fixed at parse time and never renumbered.
    # `index` is the position in THIS RUN's list, which --pick changes; the two differ only
    # on a picked run, and the difference is the whole point of --pick-keeps-numbers.
    timeline_index: int = 0
    # True when this cut was refused but a file from an earlier run is still sitting at the
    # delivery name. Nothing deletes it — deliberately — so it has to be said out loud.
    stale_delivery: bool = False
    # A render is COMING but does not exist yet — set on a scan that ran with
    # --render-planned. Kept apart from render_path, which is a file that is there: the
    # scan has to say what will be cuttable so the panel can offer it, while run_cut must
    # still refuse anything that has no actual render behind it.
    render_planned: bool = False
    # Frames this cut gave up to a dissolve, and to which end: a cut that ends in a
    # transition loses its tail to the midpoint, one that begins in a transition loses its
    # head. 0 for the great majority of cuts, which have no transition on them.
    transition_split: int = 0
    transition_split_end: str = ""

    # edit metadata
    speed_percent: float = 100.0   # always positive; a reverse shows in `reversed`
    reversed: bool = False         # played backwards on the timeline
    speed_varies: bool = False     # keyframed ramp — speed_percent is an approximation
    speed_span: str = ""           # "min–max %" when the ramp is keyframed
    # The ramp's actual keyframes, as [[seconds, speed_multiplier], ...]. Only a panel
    # dump can supply these; an XML export flattens the curve to one number. Recorded
    # for now — nothing follows the curve yet — but recorded exactly, so that when
    # something does, the data is already in the manifest.
    ramp_keys: list = field(default_factory=list)
    enabled: bool = True
    # ⚠️ WHY the clip is off, kept apart from `enabled` itself. The eye/mute toggle on a
    # whole TRACK is written as <enabled>FALSE</enabled> on the <track> element while every
    # clipitem inside stays TRUE — a different XML shape from a clip switched off on its
    # own, and by far the commoner one: on 46 unique real exports the clipitem-level flag
    # is FALSE exactly zero times, while 6 of them carry a muted track (one an entire
    # voice-over read, 37 cuts in all). `enabled` is the AND of the two so
    # the existing --disabled machinery covers both; this records which half said no,
    # because an editor who muted a layer will not recognise "disabled clips".
    track_enabled: bool = True
    # The Premiere Audio Levels fader for this item, as a LINEAR ratio, with the clipitem's
    # own level and every enclosing track's and nest's multiplied together — which is what
    # the signal actually passes through on its way to the master. 1.0 is unity / 0 dB.
    # Read by the timeline-audio mix; see read_audio_level for the measurement.
    # ffprobe's own reason for not answering about this source, empty when it did answer.
    # The difference between "the probe said there is no audio" and "the probe never ran"
    # — see probe(); run_cut refuses to make a claim about the media without it.
    probe_error: str = ""
    audio_level: float = 1.0
    audio_level_varies: bool = False   # the fader is keyframed; this is its first key
    # ⚠️ WHICH CHANNEL OF ITS FILE A MONO CLIP PLAYS. <sourcetrack><trackindex> is 1-based
    # and counts the source's audio channels across all its streams; lane_count is the
    # totalExplodedTrackCount of the lane the clip sits on (0 = the XML does not say). Only
    # a lane_count of 1 — a MONO clip — makes the mix select a channel: on a stereo lane the
    # index says which half of a stereo pair this lane is, and the pair is mixed whole.
    # MEASURED on the three real exports on hand (25 one-lane clips): every one is a
    # 1-channel file with trackindex 1, so selecting changes nothing there (the one of those
    # tracks whose media is on this machine wrote a byte-identical _track_A1.mp3 before and
    # after). It is the dual-mono camera file (lav on channel 1, boom on channel 2) that it
    # exists for. See vo_mix_command.
    source_track: int = 1
    lane_count: int = 0
    # The fades an audio <transitionitem> puts on this clip, as [{"type": "in"|"out",
    # "src_start", "src_end" (SOURCE seconds), "curve"}]. In source time so they survive a
    # nest trimming or moving the clip. See audio_fades_for().
    audio_fades: list = field(default_factory=list)
    transition_in: str = ""
    transition_out: str = ""
    edge_in_transition: str = ""   # "head", "tail" or "both" — edge reconstructed
    estimated_bytes: int = 0       # what this cut is expected to weigh, before encoding
    # WHERE that number came from, because the answer is not the same for every row and a
    # blank size cell reads as a broken tool rather than as a missing input:
    #   "measured"  a real short encode of this clip at these settings (--size-probe)
    #   "source"    the source file's own dimensions, rate and bitrate
    #   "sequence"  the SEQUENCE's frame size — for a row that has no source to read,
    #               which in render mode is exactly what the render will be
    #   "unknown"   no usable input at all; the size is genuinely not knowable yet
    estimate_basis: str = ""
    # A STABLE IDENTITY for this cut, unique within one parse of one sequence.
    #
    # ⚠️ NOT THE INDEX, AND THAT IS MEASURED. `index` is renumbered after every filter:
    # scanning a 21-cut timeline and then exporting 19 of them moved ALL NINETEEN
    # surviving indices (3->1, 4->2, 5->3, …). An index is a position in a list, not a
    # name for a thing.
    #
    # Derived instead from what does NOT move: the clip name, the track, the timeline
    # range, the source file and its range, the speed and the reverse — all read at parse
    # time, before any filter, and identical in a scan and an export of the same XML.
    # Computed BEFORE the cross-dissolve split and before --whole-frames, so neither can
    # shift it; that is a strict improvement on the four-field key, whose sensitivity to
    # the split is why the pipeline had to be reordered.
    cut_id: str = ""
    output_bytes: int = 0          # what it actually weighed, once written
    # MEASURED bits per second, from a real short encode of this clip at probe_crf. The
    # only honest basis for an estimate — see size_probe() for why the source's own
    # bitrate is not one. 0 means the probe did not run or could not.
    probe_bps: float = 0.0
    probe_crf: float = 0.0
    frame_exact: bool = True       # false once --fps resamples it
    media_kind: str = "video"      # video | still | unsupported
    nested_from: str = ""          # name of the nested sequence this came out of
    nested_trimmed: str = ""       # "head", "tail" or "both" — clipped by the nest's in/out
    filters: list = field(default_factory=list)

    # technical specs (ffprobe)
    codec: str = ""
    width: Optional[int] = None
    height: Optional[int] = None
    # What this cut was actually WRITTEN at. Equal to width/height unless --scale moved
    # it. Recorded per clip rather than only as a percentage in `settings`, because a
    # timeline mixes 1080x1920 and 2160x3840 sources and one percentage does not tell a
    # dataset reader what any individual file contains.
    output_width: Optional[int] = None
    output_height: Optional[int] = None
    source_fps: float = 0.0
    # ffprobe's avg_frame_rate, kept only so it can be compared with source_fps (its
    # r_frame_rate). Equal on constant-rate media; a gap means the file's frames are NOT
    # evenly spaced, and every frame-count-times-rate sum this tool makes about it is
    # approximate. MEASURED on a 30 fps source with one frame removed: r 30/1, avg 9000/301
    # (29.900332), and a 30-frame cut across the gap came back spanning 1.033008 s for a
    # 1.000 s timeline slot — the gap survives into the OUTPUT timestamps — with the last
    # picture a frame from past the out-point. Recorded and NAMED rather than compensated:
    # the cutting path does not resample variable-rate media, and guessing at it on footage
    # nobody here has is how a half-second error gets introduced.
    # ⚠️ ONE THING DOES READ IT: a gap here keeps the cut on 3.88's own arithmetic and
    # filters, untouched — see variable_rate_source() and keeps_base_resample().
    source_avg_fps: float = 0.0
    # Premiere's INTERPRETED rate, only ever set from a panel dump. Recorded rather
    # than used: it is the rate the edit was built against, but ffmpeg seeks the file
    # at the file's own rate, and silently converting between the two — untested, on
    # footage I have none of — is how a half-second error gets introduced. Where the
    # two disagree the clip is flagged instead.
    interpreted_fps: float = 0.0
    pix_fmt: str = ""
    bitrate: Optional[int] = None
    audio_codec: str = ""
    audio_channels: Optional[int] = None
    audio_sample_rate: Optional[int] = None

    # output
    output_file: str = ""
    pix_fmt_out: str = ""          # what was encoded; differs from pix_fmt = a conversion
    status: str = "pending"
    error: str = ""


# --------------------------------------------------------------------------
# XML parsing
# --------------------------------------------------------------------------

class SequenceChoice(Exception):
    """Raised when the XML holds several sequences and none was chosen."""
    def __init__(self, options):
        self.options = options


def _mark_audio_level(cuts: list, level: float, varies: bool) -> None:
    """Multiply an enclosing track's or nest's fader into the cuts underneath it.

    Gains COMPOUND — a clip at 0.5 on a track at 0.5 reaches the master at 0.25 — so this
    multiplies rather than assigns, and is a no-op at unity, which is what an untouched
    track looks like.
    """
    if not varies and abs(level - 1.0) <= 1e-9:
        return
    for c in cuts:
        c.audio_level = round((c.audio_level or 1.0) * level, 9)
        c.audio_level_varies = c.audio_level_varies or varies


def _lane_count(track: ET.Element) -> int:
    """totalExplodedTrackCount on this <track>: how many lanes Premiere split the clips on it
    into — 1 for mono clips, 2 for stereo. 0 when the XML does not say."""
    try:
        return max(0, int(track.get("totalExplodedTrackCount") or 0))
    except (TypeError, ValueError):
        return 0


def _mark_track_enabled(cuts: list, track_on: bool) -> None:
    """Fold a TRACK's eye/mute toggle into the cuts that came off it.

    A no-op on an ordinary track, which is why it is safe to call at every emit site: only
    a <track> carrying <enabled>FALSE</enabled> reaches the second line. `enabled` is ANDed
    rather than assigned so a clip switched off inside a track that is on stays off, and a
    nest on a muted track stays off no matter what its inner tracks said.
    """
    if track_on:
        return
    for c in cuts:
        c.track_enabled = False
        c.enabled = False


class Timeline:
    def __init__(self, xml_path: Path, remaps: list[tuple[str, str]],
                 select: Optional[Union[str, int]] = None, nest_mode: str = "all",
                 render_mode: bool = False):
        self.xml_path = xml_path
        # Whether the pixels will come from Premiere's render. Read by ONE thing: the
        # wording of the no-media advisory, which is written at parse time and used to tell
        # an editor already in Timeline Render to switch to Timeline Render. nest_mode
        # cannot stand in for it — render mode under --nest resolve parses with "all", the
        # same value source mode uses. Defaults to False so every in-process construction
        # (the GUI, the tools, the test suites) keeps the source-mode sentence it had.
        self.render_mode = bool(render_mode)
        self.remaps = remaps
        self.select = select
        # WHAT A NESTED SEQUENCE BECOMES. Two states:
        #
        #   "one-cut"  render mode's default. A clipitem holding a <sequence> becomes ONE
        #              cut spanning its own parent-timeline start/end. Premiere renders the
        #              nest with every inner layer baked in, which is the whole point of
        #              render mode — so there is nothing to look inside for.
        #   "all"      source mode always, and render mode under --nest resolve. Every
        #              inner track resolves onto the parent's track.
        #
        # ⚠️ AN INNER-V1-ONLY STATE WAS BUILT AND THEN DELETED, on measurement. "Treat the
        # nest like the main timeline" reads at first as the master-track model — the nest's
        # own V1 sets the cut points, upper layers are picture. On the one real nest
        # available that rule cuts NOTHING: inner V1 and V2 are empty placeholder tracks
        # (Premiere writes those) and the 35-shot spine runs along inner V5 and V6, split
        # across two tracks because the editor dragged clips up under dissolves. Every
        # single-track choice loses part of the edit — 0 cuts from the empty V1, 2 from V3,
        # or 27 of 35 from V5 while dropping V6's 8. And the main timeline's own default is
        # every video track (--video-track 0), so "like the main timeline" literally means
        # all of them. The cost, accepted: a genuine title layer comes through as a cut.
        #
        # Defaults to "all" so every existing in-process construction — the test suites,
        # overlay_dump, verify.py — behaves exactly as it did before this existed.
        self.nest_mode = nest_mode
        # Nests collapsed to one cut. Counted so the advisory can say so ONCE rather than
        # per item, and so a number that shrinks can never do it quietly.
        self.nests_one_cut: list[str] = []
        # Cuts merged into an earlier identical cut. Recorded as PAIRS, not a count: the
        # list got SHORTER, and a clip count that quietly moves from 31 to 22 is the exact
        # pattern that cost a day of misdiagnosis.
        self.merged_duplicates: list[dict] = []
        self.files: dict[str, dict] = {}
        # <sequence> DEFINITIONS by id, for the same reason self.files exists: a nest's
        # second appearance in the document is a bare <sequence id="…"/> with no children
        # at all, and the frames it plays live on the first appearance. MEASURED on a real
        # Premiere export — see _register_sequence.
        self.sequences: dict[str, ET.Element] = {}
        self.cuts: list[Cut] = []
        # The timeline's AUDIO clipitems, kept whatever --tracks does to the cut list — the
        # voice-over mix reads them as a source rather than writing them as files of their own.
        self.audio_items: list[Cut] = []
        # Audio inside nests that --nest one-cut collapsed. Never cut, only mixed — see
        # _nest_audio_for_mix.
        self.nest_audio_items: list[Cut] = []
        # (premiere track, start, end, name) of every audio transition no clip edge claimed.
        self.audio_transitions_unplaced: set = set()
        self.markers: list[dict] = []
        # Things the caller must be told rather than left to discover: keyframed ramps
        # flattened, nests that resolved to nothing, nesting too deep to follow.
        self.warnings: list[str] = []
        self.sequence_name = ""
        # Premiere's sequenceID, when a panel dump names this timeline (see
        # panel_sequence_id). An XML carries none of its own, so the CLI path leaves it "".
        self.sequence_id = ""
        self.sequence_fps = 25.0
        # ⚠️ WHAT THE AUDIO A-NUMBERS ACTUALLY MEAN ON THIS PATH, and it
        # defaults to "unknown" ON PURPOSE. The manifest used to hardcode "premiere",
        # so the dump path advertised Premiere numbering while having applied none of
        # it — a field that lies is worse than a field that is absent. Each path
        # opts in beside the code that does the work, so a new one that forgets says
        # "unknown" rather than claiming credit.
        self.audio_numbering = "unknown"
        # The sequence's own frame size, from <media><video><format>. Needed because
        # a RENDER is the sequence, not the source: for a cut with no source file to
        # read, these are the only honest dimensions to price an output from.
        self.sequence_width = 0
        self.sequence_height = 0
        self.sequence_duration_frames = 0
        self.available_sequences: list[dict] = []
        # Why clipitems did not become cuts. Counted rather than warned one-by-one: a real
        # timeline had 31 title graphics with no media, and 31 identical warnings is a wall
        # nobody reads. Summarised at the end of _parse().
        self.skipped: dict = {}
        self._parse()

    @staticmethod
    def top_level_sequences(root: ET.Element) -> list[ET.Element]:
        """Project sequences only — not the ones living inside a nested clipitem.

        `.//sequence` also returns every nested sequence, which then shows up in the
        picker as though it were a timeline you might have meant to cut. On a real
        project that is an invitation to cut the wrong thing.
        """
        nested = {id(s) for s in root.findall(".//clipitem/sequence")}
        return [s for s in root.findall(".//sequence") if id(s) not in nested]

    @staticmethod
    def list_sequences(xml_path: Path) -> list[dict]:
        root = ET.parse(xml_path).getroot()
        out = []
        for i, seq in enumerate(Timeline.top_level_sequences(root), start=1):
            fps = parse_rate(seq.find("rate"), 25.0)
            dur = int(num(seq, "duration", 0) or 0)
            out.append({
                "index": i,
                "name": txt(seq, "name", f"Sequence {i}"),
                "fps": round(fps, 3),
                "duration_frames": dur,
                "duration_tc": frames_to_tc(dur, fps),
                "clip_count": len(seq.findall(".//clipitem")),
            })
        return out

    def _pick_sequence(self, root: ET.Element) -> ET.Element:
        seqs = self.top_level_sequences(root)
        if not seqs:
            raise SystemExit("No <sequence> found — is this a Final Cut Pro 7 XML export?")

        self.available_sequences = self.list_sequences(self.xml_path)

        if len(seqs) == 1:
            return seqs[0]

        if self.select is None:
            # Premiere exports the WHOLE project, so multi-sequence XML is common.
            # Guessing here would silently cut the wrong timeline.
            raise SequenceChoice(self.available_sequences)

        # ⚠️ THREE WAYS THIS PICKED ANOTHER TIMELINE WITHOUT A WORD, all measured on the
        # fixture with its second sequence renamed. The panel passes the Premiere name
        # here, and in the project-level fallback (host.jsx, when the sequence-level export
        # writes nothing) the XML holds every sequence, so this is what decides which
        # timeline becomes the editor's files:
        #
        #   * a name that is ALL DIGITS was always read as a position. `--sequence 1` with
        #     the second sequence named "1" cut sequence #1, 21 cuts of the wrong edit; a
        #     sequence named "2026" could not be chosen at all ("out of range (1..2)").
        #   * two sequences with the SAME name: exact[0], silently. The ambiguity check
        #     only ever ran on partial matches.
        #   * the requested name was never STRIPPED while txt() strips every name read from
        #     the XML, so "Main " missed "Main" exactly and the only partial match, "Main v2",
        #     was cut instead.
        #
        # Where the two readings disagree, or two sequences answer to one name, a BARE
        # value now REFUSES rather than choosing: a wrong timeline cut in full looks
        # exactly like the right one until someone watches it.
        #
        # ⚠️ AND THAT REFUSAL MUST NOT REACH A CALLER THAT ALREADY KNOWS WHICH READING IT
        # MEANT. The GUI sends the list POSITION of the option picked, the walk-through the
        # number typed, the panel the NAME it read. Given only the bare string, each of them
        # hit the refusal above on an XML whose sequences are named "2" and "1" in that
        # order (the fixture with its two names swapped for digits): position 1 is "2" and
        # name "1" is #2, so the GUI could cut neither. So there are two EXPLICIT forms, and
        # neither does any guessing:
        #   * position: an int (what the in-process callers pass), or "pos:N" on the CLI.
        #     Not "#N": an unquoted `#` starts a comment in bash, so `--sequence #2` would
        #     reach argparse as a flag with no value.
        #   * name: "name:NAME". EXACT (stripped, case-insensitive), no partial fallback:
        #     the panel read that very name, so a sequence that merely CONTAINS it is some
        #     other timeline.
        # A bare value keeps every reading it had, so an older front end still works.
        sel_raw = self.select
        if isinstance(sel_raw, int) and not isinstance(sel_raw, bool):
            mode, sel = "pos", str(sel_raw)
        else:
            sel = str(sel_raw).strip()
            head = sel[:5].lower()
            # ⚠️ AN EXPLICIT FORM IS NEVER SECOND-GUESSED — that is the only thing it is for.
            # A first version of this let a sequence whose whole name matched the string win
            # before the prefix was read, and the merge review measured what that costs: with
            # sequences named "2" and "name:2", the panel's own "name:2" cut the wrong one,
            # exit 0; and "pos:1" stopped meaning position 1 whenever another sequence was
            # literally named "pos:1" — which is the spelling this engine's own ambiguity
            # message tells people to type. So: "pos:" is explicit only when a number follows
            # ("POS: Spot 30s" is somebody's sequence name, read bare), and "name:" is
            # explicit, with the literal whole string as a fallback ONLY when the explicit
            # reading finds nothing (see the refusal below).
            _rest = sel[4:].strip() if head.startswith("pos:") else ""
            if head.startswith("pos:") and _rest.isascii() and _rest.isdigit():
                mode, sel = "pos", _rest
            elif head == "name:":
                mode, sel = "name", sel[5:].strip()
            else:
                mode = "bare"
        # isascii(): str.isdigit() is also true of "²", which int() then rejects with a
        # traceback instead of a message.
        is_num = sel.isascii() and sel.isdigit()
        target = sel.lower()
        exact = [i for i, s in enumerate(seqs) if txt(s, "name").lower() == target]

        def _numbered(ix):
            return ", ".join(f"#{i + 1}" for i in ix)

        if mode == "pos":
            if is_num and 1 <= int(sel) <= len(seqs):
                return seqs[int(sel) - 1]
            raise SystemExit(f"error: --sequence pos:{sel} is not a position in this XML "
                             f"(1..{len(seqs)}). Use --list-sequences.")

        if mode == "bare" and is_num:
            i = int(sel)
            if 1 <= i <= len(seqs):
                # A position nobody else claims by name, or the name agrees with it.
                if not exact or exact == [i - 1]:
                    return seqs[i - 1]
                raise SystemExit(
                    f"error: --sequence {sel} is ambiguous: it is the POSITION of sequence "
                    f"#{i} ({txt(seqs[i - 1], 'name')!r}) and the NAME of sequence "
                    f"{_numbered(exact)}. Say which you mean: --sequence pos:{i} for the "
                    f"sequence at #{i}, or --sequence name:{sel} for the one named {sel!r}.")
            if not exact:
                raise SystemExit(f"error: --sequence {i} out of range (1..{len(seqs)})")
            # Out of range as a position, so it can only be a name: fall through.

        if len(exact) > 1:
            raise SystemExit(
                f"error: --sequence {self.select!r} is ambiguous: {len(exact)} sequences are "
                f"named that ({_numbered(exact)}). Pick one by position — "
                + " or ".join(f"--sequence pos:{i + 1}" for i in exact)
                + " — after checking --list-sequences, or rename one in Premiere.")
        if exact:
            return seqs[exact[0]]
        if mode == "name":
            # The fallback, and the only place a literal "name:…" sequence name is honoured:
            # nothing is named what the explicit form asked for, so a sequence whose WHOLE
            # name is the string itself is the only thing the caller can have meant.
            _lit = [s for s in seqs if txt(s, "name").strip().lower() == str(sel_raw).strip().lower()]
            if len(_lit) == 1:
                return _lit[0]
            raise SystemExit(f"error: no sequence named {sel!r} in this XML. "
                             f"Use --list-sequences.")
        partial = [s for s in seqs if target in txt(s, "name").lower()]
        if len(partial) == 1:
            return partial[0]
        if len(partial) > 1:
            names = ", ".join(txt(s, "name") for s in partial)
            raise SystemExit(f"error: --sequence {self.select!r} is ambiguous: {names}")
        raise SystemExit(f"error: no sequence named {self.select!r}. Use --list-sequences.")

    # -- path resolution --------------------------------------------------
    def _resolve(self, path: str) -> str:
        """Rewrite a source path through --remap OLD=NEW, matching whole folders only.

        ⚠️ A BARE PREFIX MATCH REWRITES THE SIBLING FOLDER TOO. This was
        `path.startswith(old)`, so `--remap /Volumes/Old=/NEW` turned
        `/Volumes/Old2/B.mp4` into `/NEW2/B.mp4` and `/Volumes/Oldies/C.mp4` into
        `/NEWies/C.mp4` — measured, both. The clip is then reported missing at a path that
        never existed, or, if the mangled path happens to resolve, cut from a different
        file. It also ate the sibling's OWN pair: once `/Volumes/Old2/…` had been rewritten,
        a later `--remap /Volumes/Old2=…` found nothing left to match.

        So the match has to end on a path separator, and only the FIRST pair that matches
        applies — chaining one pair's output into the next pair's input is not what
        `--remap A=B --remap C=D` means to anyone typing it. The splice itself is unchanged
        (`new + path[len(old):]`), which keeps every OLD/NEW spelling that works today
        working, including the trailing slash the panel puts on the OLD half.
        """
        for old, new in self.remaps:
            if not old:
                continue
            if path == old or path.startswith(old if old.endswith("/") else old + "/"):
                return new + path[len(old):]
        return path

    # -- file table -------------------------------------------------------
    def _register_file(self, file_node: ET.Element) -> str:
        """FCP7 defines a <file> fully once; later clipitems reference it by id only."""
        fid = file_node.get("id", "")
        if not fid:
            fid = txt(file_node, "name") or f"anon-{len(self.files)}"
        has_body = file_node.find("pathurl") is not None or file_node.find("name") is not None
        if fid in self.files and not has_body:
            return fid
        if not has_body:
            return fid

        raw = txt(file_node, "pathurl")
        path = self._resolve(pathurl_to_path(raw))
        fps = parse_rate(file_node.find("rate"), self.sequence_fps)

        entry = self.files.get(fid, {})
        entry.update({
            "id": fid,
            "name": txt(file_node, "name"),
            "pathurl": raw,
            "path": path,
            "fps": fps,
            "duration": num(file_node, "duration", 0.0),
        })
        self.files[fid] = entry
        return fid

    # -- nested sequence table --------------------------------------------
    def _register_sequence(self, seq_node: ET.Element) -> None:
        """Index a <sequence> that has a body, so a later bare reference can find it.

        The same idiom as <file>, MEASURED on a real Premiere FCP7 export rather than
        inferred — a timeline using one nest twice writes:

            <clipitem id="clipitem-42">  <name>a nest clipitem</name>
              <start>0</start> <end>1366</end> <in>0</in> <out>1366</out>
              <sequence id="sequence-2">  duration rate name media timecode logginginfo
            <clipitem id="clipitem-80">  <name>a nest clipitem</name>
              <start>1366</start> <end>1586</end> <in>1366</in> <out>1586</out>
              <sequence id="sequence-2"/>          <- NO CHILDREN AT ALL

        The placeholder carries no name, no rate and no duration; its only identity is the
        id attribute. The human-readable name lives on the enclosing clipitem, which is
        where _parse_nested already looks for it.

        ⚠️ THE TWO INSTANCES ARE NOT DUPLICATES. On that export the inline one plays the
        nest's frames 0-1366 and the reference plays 1366-1586 — 220 frames of different
        content, which resolved to nothing at all before this existed.

        UNLIKE _register_file this records only DEFINITIONS. A file entry is a dict that a
        reference still needs to exist so the lookup does not fail; a sequence reference is
        resolved BY the index, so storing body-less elements would let a reference
        overwrite the definition it is trying to find. Registering in one pass ahead of the
        walk keeps it order-independent: the definition may appear after the reference and
        this does not care.
        """
        sid = seq_node.get("id", "")
        if not sid or seq_node.find("media") is None:
            return
        self.sequences[sid] = seq_node

    # -- main parse -------------------------------------------------------
    def _parse(self):
        root = ET.parse(self.xml_path).getroot()
        seq = self._pick_sequence(root)

        self.sequence_name = txt(seq, "name", "Untitled Sequence")
        self.sequence_fps = parse_rate(seq.find("rate"), 25.0)
        self.sequence_duration_frames = int(num(seq, "duration", 0) or 0)
        _fmt = seq.find("media/video/format/samplecharacteristics")
        if _fmt is not None:
            self.sequence_width = int(num(_fmt, "width", 0) or 0)
            self.sequence_height = int(num(_fmt, "height", 0) or 0)

        # Register every <file> in the DOCUMENT before walking the chosen sequence.
        #
        # FCP7 defines a <file> in full at its first appearance anywhere in the export and
        # refers to it by id alone after that. Registering only as the chosen sequence was
        # walked therefore lost any file whose full definition sits under a DIFFERENT
        # sequence — its clipitems resolve to no path and are dropped, silently. The
        # fixture demonstrates it: `--sequence OLD_v6_DO_NOT_USE` used to report
        # "No cuts found" for a sequence that plainly has a clip in it.
        #
        # This matters for a project-level export, which holds every sequence — which is
        # exactly what the panel falls back to when Premiere will not export a single
        # sequence, and what anyone using --sequence has.
        #
        # After sequence_fps is known, because that is the fallback for a file with no rate
        # of its own. Full definitions overwrite references, so order within the document
        # does not matter.
        for f in root.iter("file"):
            self._register_file(f)

        # And every <sequence> that has a body, for exactly the same reason and in the same
        # pass: a nest used twice is defined once and referenced by id alone after that.
        # Order-independent, so a definition later in the document than its reference
        # resolves just as well.
        for s in root.iter("sequence"):
            self._register_sequence(s)

        for m in seq.findall("marker"):
            self.markers.append({
                "name": txt(m, "name"),
                "comment": txt(m, "comment"),
                "in_frames": int(num(m, "in", -1) or -1),
                "out_frames": int(num(m, "out", -1) or -1),
                "in_tc": frames_to_tc(num(m, "in", 0) or 0, self.sequence_fps),
            })

        media = seq.find("media")
        if media is None:
            raise SystemExit("Sequence has no <media> section.")

        for track_type in ("video", "audio"):
            section = media.find(track_type)
            if section is None:
                continue
            # ⚠️ AUDIO ONLY. Video lanes carry no exploded attributes, so the rule would
            # return 1..n for them anyway — but computing it only for audio makes it
            # impossible for a future Premiere that DOES write them on video to renumber
            # video tracks as a side effect. Video numbering is not part of this fix.
            lanes = (self.premiere_track_numbers(section, track_type)
                     if track_type == "audio" else [])
            if track_type == "audio":
                # Derived from Premiere's own currentExplodedTrackIndex grouping, and
                # equal to document order when that attribute is absent — which is
                # Premiere's numbering for a timeline with no exploded lanes.
                self.audio_numbering = "premiere"
            for t_idx, track in enumerate(section.findall("track"), start=1):
                p_track = lanes[t_idx - 1] if t_idx - 1 < len(lanes) else t_idx
                # ⚠️ THE TRACK'S OWN EYE/MUTE TOGGLE, which nothing here read until now.
                # Premiere writes it as <enabled>FALSE</enabled> on the <track>; the
                # clipitems inside stay TRUE, so _parse_clipitem's clipitem-level read
                # cannot see it. MEASURED on 46 unique real exports: 6 of them carry a
                # muted track holding 37 clipitems, and NOT ONE clipitem anywhere in that
                # corpus carries the flag on its own — so the check the code did have has
                # never once fired on this reviewer's work, and the case that does occur is
                # the one it could not see. Shipping 3.58 delivered all 37 as
                # finished-edit material, every row `enabled: true`, `disabled_found: 0`,
                # completeness "all N cuts on the timeline". One was an entire voice-over
                # read the editor had switched off. Folded into Cut.enabled rather than
                # given a flag of its own so --disabled already covers it — and because
                # this runs at parse time, ahead of the audio_items capture in main(), a
                # muted VO track also stops reaching _timeline_audio.mp3 and the panel's
                # VO menu. <enabled> is absent on an ordinary track, so the default TRUE
                # leaves every timeline without a hidden track byte-identical.
                track_on = txt(track, "enabled", "TRUE").strip().upper() != "FALSE"
                # The TRACK fader, which multiplies with every clip's own. 163 of the
                # measured corpus's track-level Audio Levels filters are not unity.
                track_level, track_level_kf = read_audio_level(track)
                transitions = self._collect_transitions(track, self.sequence_fps)
                edges = self.resolve_transition_edges(track, self.sequence_fps)
                for clip in track.findall("clipitem"):
                    # A clipitem holds EITHER a <file> or a nested <sequence>. Skipping
                    # the latter silently drops every cut inside the nest — real
                    # timelines here do use nests, so those clips were simply absent
                    # from the dataset with nothing to show they were missing.
                    if clip.find("sequence") is not None:
                        # ⚠️ RENDER MODE'S DEFAULT IS ONE CUT PER NEST INSTANCE, and it
                        # deliberately reads NOTHING out of the nest's definition — only
                        # this clipitem's own start/end/in/out. So it does not care whether
                        # the <sequence> carries a <media> or is a bare id reference, and
                        # a nest used twice becomes two cuts either way.
                        if self.nest_mode == "one-cut":
                            cut = self._parse_clipitem(clip, track_type, t_idx,
                                                       transitions, edges=edges,
                                                       premiere_track=p_track)
                            if cut:
                                _mark_track_enabled([cut], track_on)
                                _mark_audio_level([cut], track_level, track_level_kf)
                                self.nests_one_cut.append(cut.clip_name)
                                self.cuts.append(cut)
                            if track_type == "audio":
                                self._nest_audio_for_mix(clip, t_idx, edges, p_track,
                                                         track_on, track_level,
                                                         track_level_kf)
                            continue
                        # A nest sitting on a muted track is muted whatever its inner
                        # tracks say, so the parent's flag is applied to everything the
                        # nest gave back — the inner loop applies the inner tracks' own.
                        _nested = self._parse_nested(clip, track_type, t_idx,
                                                     depth=1, edges=edges,
                                                     premiere_track=p_track)
                        _mark_track_enabled(_nested, track_on)
                        _mark_audio_level(_nested, track_level, track_level_kf)
                        self.cuts.extend(_nested)
                        continue
                    cut = self._parse_clipitem(clip, track_type, t_idx,
                                               transitions, edges=edges,
                                               premiere_track=p_track)
                    if cut:
                        _mark_track_enabled([cut], track_on)
                        _mark_audio_level([cut], track_level, track_level_kf)
                        cut.lane_count = _lane_count(track)
                        self.cuts.append(cut)
                if track_type == "audio":
                    self._note_unplaced_audio_transitions(transitions, p_track)

        # order by timeline position, video first
        # Everything that did not become a cut, said once per reason. This is what makes
        # "the export has fewer clips than the timeline" self-diagnosing instead of a
        # bug report.
        for why, e in sorted(self.skipped.items()):
            names = ", ".join(e["names"])
            more = "" if e["count"] <= len(e["names"]) else ", …"
            # ⚠️ "WERE NOT CUT" IS AN ACCUSATION, and for one of these reasons it is the
            # wrong one. Most skips are things going wrong — a -1 transition boundary, a
            # clip with no usable length — and that phrasing is right for them. A title is
            # not one of those: it appears on every timeline that has titles, and this
            # sentence is what the panel puts on the rail, so the commonest normal export
            # in this shop opened by announcing 31 clipitems that "were not cut". The
            # advisory reasons state what the clips ARE, so the count introduces them
            # rather than indicting them.
            self.warnings.append(
                (f"{e['count']} clip(s): {why}" if is_advisory_warning(why)
                 else f"{e['count']} clipitem(s) were not cut — {why}")
                + (f": {names}{more}" if names else ""))

        # ⚠️ SAID OUT LOUD, both of them. A cut count that quietly shrinks because the
        # engine stopped looking inside something is the exact class of bug this whole
        # thread started with — "62 video clips as Premiere counts them · 56 cut(s) read".
        if self.nests_one_cut:
            shown = sorted(set(self.nests_one_cut))
            self.warnings.append(
                f"{len(self.nests_one_cut)} nested sequence instance(s) cut as ONE clip "
                f"each: "
                + ", ".join(shown[:4]) + (", …" if len(shown) > 4 else "")
                + ". --nest resolve cuts the clips inside them instead")

        self.cuts.sort(key=lambda c: (c.timeline_in_frames, c.track_type != "video", c.track_index))
        self._drop_empty_cuts()
        self._drop_duplicate_cuts()
        self._assign_cut_ids()
        for i, c in enumerate(self.cuts, start=1):
            c.index = i

    def _nest_audio_for_mix(self, clip, t_idx, edges, p_track, track_on, level,
                            level_kf) -> None:
        """The audio INSIDE a nest that --nest one-cut is cutting as a single clip.

        ⚠️ ONE-CUT IS A PICTURE DECISION, AND IT WAS TAKING THE SOUND WITH IT. Render mode
        defaults a nest to one cut because Premiere's render already holds every inner layer
        — true of the pixels, and irrelevant to the mix, which is built from SOURCE files
        whatever the mode. The nest's audio clipitem became one cut with no file, media_kind
        "unsupported", and the audio_items capture in main() dropped it: MEASURED on the
        audit fixture, a voice-over nested on A1 was absent from _timeline_audio.mp3 in
        Timeline Render (1 kHz band -76 dB where the source reads -15), A1 vanished from
        audio_tracks_available so the panel offered no tick for it, and the same XML in
        source mode mixed it at the right offset. The panel never sends --nest, so this was
        every Timeline Render export with a nested voice-over.

        So the nest is ALSO resolved, here, for the mix only: its inner audio cuts go to
        self.nest_audio_items and never into self.cuts, so the cut list, the render's file
        names and every video decision stay exactly what one-cut makes them.

        ⚠️ SILENT ON PURPOSE. This second walk would repeat every window and skip warning
        _parse_nested writes — about clips that, in this mode, nobody is cutting. They are
        rolled back; anything the mix itself leaves out, it reports in its own note.
        """
        n_warn = len(self.warnings)
        skipped = {k: {"count": v["count"], "names": list(v["names"])}
                   for k, v in self.skipped.items()}
        try:
            inner = self._parse_nested(clip, "audio", t_idx, depth=1, edges=edges,
                                       premiere_track=p_track)
        finally:
            del self.warnings[n_warn:]
            self.skipped = skipped
        _mark_track_enabled(inner, track_on)
        _mark_audio_level(inner, level, level_kf)
        self.nest_audio_items.extend(inner)

    def _note_unplaced_audio_transitions(self, transitions, p_track) -> None:
        """Audio transitions audio_fades_for() could not tie to a clip edge, kept so the mix
        can say how many fades it did NOT reproduce instead of leaving them out in silence.
        Keyed per Premiere track, so a stereo pair's two lanes count once."""
        for tr in transitions:
            if not tr.get("claimed"):
                self.audio_transitions_unplaced.add(
                    (int(p_track), tr["start"], tr["end"], tr.get("name", "")))

    def _drop_empty_cuts(self) -> None:
        """Drop cuts that occupy NO TIME on the timeline.

        ⚠️ REGRESSION GUARD, and it earns its place: 3.59's retimed-nest window is derived
        from pproTicksIn/pproTicksOut, which are sub-frame precise. A clipitem that grazes
        the edge of an instance's window by a fraction of a frame then yields a cut whose
        timeline span rounds to ZERO — and `max(1, ...)` on the frame pin turned each one
        into a 1-frame file. Measured on a real export: 3.57 and 3.58 gave 52 video cuts
        with none of these; 3.59 gave 56, of which two were 0.009s and 0.003s slivers
        delivered as single frames beside the shots they were shaved off.

        FCP7's <end> is EXCLUSIVE, so a genuine one-frame clip has a span of ONE, not zero.
        The two are cleanly separable and this drops only the degenerate case. Counted and
        warned rather than discarded quietly — a cut vanishing in silence is the failure
        mode this whole file is organised against.
        """
        empty = [c for c in self.cuts
                 if (c.timeline_out_frames - c.timeline_in_frames) <= 0]
        if not empty:
            return
        self.cuts = [c for c in self.cuts
                     if (c.timeline_out_frames - c.timeline_in_frames) > 0]
        shown = ", ".join(f"{c.clip_name} at {c.timeline_in_frames}" for c in empty[:4])
        self.warnings.append(
            f"{len(empty)} cut(s) occupied no time on the timeline and were dropped: "
            f"{shown}" + (", …" if len(empty) > 4 else ""))

    def _drop_duplicate_cuts(self) -> None:
        """Emit a cut once, not twice, when a second one would be byte-for-byte identical.

        ⚠️ THE BUG THIS FIXES, from a real run: nine pairs of progress lines like

            >> video/1/0/31   01_(02.00-03.03)_<stem>.mp4
            >> video/1/0/31   02_(02.00-03.03)_<stem>.mp4

        Same track, same timeline in AND out, same source file, same source range. Thirty-one
        files written for a twenty-two-clip master track: 31 - 9 = 22, and the nine extras
        were redundant copies.

        WHERE THEY COME FROM. A nested sequence's inner clipitems are all stamped with the
        PARENT clipitem's track index — they are placed on the parent's timeline, so that is
        right — but a nest with STACKED inner video tracks can hold the same shot on inner V1
        and inner V2 across the same span. Flattened onto one parent track those become two
        cuts identical in every field that decides an output.

        WHY DE-DUPLICATION RATHER THAN RENUMBERING. pick_key is (track type, track index,
        timeline in, timeline out); it is also render_name, and the panel's clipKey. Giving
        inner clips a synthetic track index would make those keys unique but would put nested
        cuts on a track number the timeline does not have, and --video-track (which render
        mode uses to keep only the master track) would then drop every nested cut. Refusing to
        resolve such a nest loses the clips. Dropping a duplicate loses NOTHING: the second
        cut would have produced the same bytes under a different index.

        ⚠️ AND IT IS ALSO THE PANEL SYMPTOM: "two videos in the same nested sequence are
        linked to each other" — untick one and the other unticks too. The panel's row identity
        is those same four fields, so two colliding cuts were always one row to it. There is
        one row now because there is one cut.

        ⚠️ THE IDENTITY IS THE USER'S OWN, AND THE TIMELINE POSITION IS THE PART THAT MUST
        NOT BE DROPPED: "detect if the clip name and the in out, duration is the same mark
        them as one" — plus the timeline position, which he confirmed after being shown the
        case that breaks without it. Two files in one of his own output folders share a
        name, a source range and a byte size and are BOTH legitimate: the same source clip
        placed twice at two different points on the timeline, which is two real shots.
        Merging on name and source range alone deletes one of every such pair.

        So: clip name + source in/out + duration + TIMELINE in/out. Track is in there too,
        because the same clip on two tracks at one instant is two different pictures; speed
        and reverse are in there because they change the pixels. The key is therefore wider
        than pick_key in every direction — anything that could alter a single output byte,
        or even the label on it, keeps both cuts.
        """
        if not self.cuts:
            return
        seen: dict = {}
        keep: list[Cut] = []
        for c in self.cuts:
            key = (c.clip_name or "",
                   c.track_type, int(c.track_index),
                   c.timeline_in_frames, c.timeline_out_frames,
                   c.source_path,
                   round(c.source_in_seconds or 0.0, 6),
                   round(c.source_duration_seconds or 0.0, 6),
                   round(c.speed_percent or 100.0, 6),
                   bool(c.reversed),
                   # ⚠️ ENABLED IS PART OF THE IDENTITY, and its absence deleted the clip
                   # the editor KEPT. This merge runs at parse time; `--disabled drop` runs
                   # ~3600 lines later in main(). Stack the same shot on two inner layers of
                   # a nest and switch the lower one off — an ordinary move, and the engine's
                   # own _assign_cut_ids notes record 7 such pairs in one real nest — and the
                   # disabled copy is the one Premiere writes FIRST, so it won the merge and
                   # the visible take was discarded as "identical". `--disabled drop` then
                   # removed the survivor. Measured on a fixture: 21 cuts became 20, the
                   # enabled clip had no manifest row, no file and no warning naming it,
                   # while both explanatory messages described the switched-off copy.
                   bool(c.enabled))
            if key in seen:
                self.merged_duplicates.append({
                    "name": c.clip_name or "(unnamed)",
                    "kept": seen[key].clip_name or "(unnamed)",
                    "track": f"{c.track_type[0].upper()}{int(c.track_index)}",
                    "in": c.timeline_in_frames,
                    "out": c.timeline_out_frames,
                    "nested_from": c.nested_from or "",
                })
                continue
            seen[key] = c
            keep.append(c)
        self.cuts = keep
        if self.merged_duplicates:
            # NAMED, WITH WHERE. A count on its own sends you looking through the whole
            # timeline; these lines say which clip and which frames.
            rows = [f"{d['name']} on {d['track']} at {d['in']}-{d['out']}"
                    + (f" (in {d['nested_from']})" if d["nested_from"] else "")
                    for d in self.merged_duplicates]
            self.warnings.append(
                f"{len(self.merged_duplicates)} cut(s) merged into an identical earlier "
                f"cut (same name, source range, timeline position — stacked inner video "
                f"tracks in a nest): "
                + "; ".join(rows[:6]) + (f"; … and {len(rows) - 6} more"
                                         if len(rows) > 6 else ""))

    def _assign_cut_ids(self) -> None:
        """A stable per-cut identity, for selectors that cannot be told apart otherwise.

        ⚠️ WHY THIS EXISTS. pick_key is (track type, track index, timeline in, timeline
        out), and two GENUINELY DIFFERENT pictures can occupy exactly the same frames of
        one track — a plain graphic on one inner layer of a nest and a decorated variant on
        the layer above. De-duplication cannot help there: both hold real pixels, so both
        must survive, and then they answer to one selector. MEASURED on a real export: 7
        such pairs in a single nest, and because source mode always resolves nests this is
        reachable in ordinary use rather than behind a flag.

        The consequence without an id is the linked-tick the reviewer reported — the panel's
        row identity is those same four fields, so unticking one row unticks its twin.

        The id is a short digest of everything that identifies the cut and nothing that
        depends on what else survived a filter. Same input XML, same sequence, same id, in
        the scan and in the export.
        """
        seen: dict = {}
        for c in self.cuts:
            base = "\u0000".join(str(x) for x in (
                c.clip_name or "",
                c.track_type, int(c.track_index),
                c.timeline_in_frames, c.timeline_out_frames,
                c.source_path,
                round(c.source_in_seconds or 0.0, 6),
                round(c.source_duration_seconds or 0.0, 6),
                round(c.speed_percent or 100.0, 6),
                bool(c.reversed),
                c.nested_from or "",
            ))
            # An occurrence counter for anything still tied. _drop_duplicate_cuts has
            # already removed exact repeats, so this should never fire — it is here so that
            # if it ever does, the ids stay UNIQUE instead of silently colliding again.
            n = seen.get(base, 0)
            seen[base] = n + 1
            raw = base if n == 0 else f"{base}\u0000#{n}"
            c.cut_id = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]

    def premiere_track_numbers(self, section: ET.Element, track_type: str) -> list[int]:
        """Lane ordinal -> Premiere track number, for one <video>/<audio> section.

        ⚠️ PREMIERE EXPLODES ONE AUDIO TRACK INTO ONE <track> PER CHANNEL. On the one real
        export available, the <audio> section holds NINE <track> elements for FOUR audio
        tracks, so the document ordinal is a per-channel LANE index wearing an A-number.
        That number reached --audio-tracks and the panel menu, which offered seven rows for
        a four-track timeline — and `--audio-tracks 2` and `--audio-tracks 3` produced
        byte-identical mp3s of the background music while the panel's own mismatch alarm
        stayed quiet, because the filter applied perfectly to a meaningless number.

        Premiere states the grouping itself, in ATTRIBUTES on <track>. MEASURED:

            lane items currentExplodedTrackIndex totalExplodedTrackCount  ->  track
              1     9              0                        1                  A1
              2     2              0                        2                  A2
              3     2              1                        2                  A2
              4     3              0                        2                  A3
              5     3              1                        2                  A3
              6     1              0                        2                  A4
              7     1              1                        2                  A4
              8     0              0                        2                  A5 (empty)
              9     0              1                        2                  A5 (empty)

        So: absent or 0 starts a new track, non-zero continues the current one. Decided from
        the ATTRIBUTES ALONE, before any clipitem is looked at, so an empty lane is numbered
        like a populated one and consumes its group number without resetting anything — an
        empty pair sitting between A1 and the music shifts every track above it, and a
        content-derived rule cannot even see it.

        ⚠️ totalExplodedTrackCount IS NOT THE DRIVER, and must not become one: lane 1 above
        is a `total=1` stereo track, because its clips are mono. Lane count follows the
        CLIPS' channel width, not the track's. It is used here only as a consistency check.

        ⚠️ THE sourcetrack/trackindex RULE IS REFUTED — do not re-derive it. It collapses
        both tests/PROMO_MASTER_v7.xml and the fixture check_audio_tracks.py generates into
        a single audio track, it cannot number an empty lane at all, and a mono clip on a
        stereo track writes ONE lane while an empty stereo track writes TWO.

        Backward compatible by construction: the attribute is absent on every existing
        fixture in this repo and on every <video> lane, and absent means "start a new
        track", so the result is 1..n — byte-identical to the enumerate() this replaces.
        """
        tracks = section.findall("track")
        out: list[int] = []
        counter = 0
        for lane, track in enumerate(tracks, start=1):
            raw = track.get("currentExplodedTrackIndex")
            if raw is None:
                counter += 1
            else:
                try:
                    cet = int(raw)
                except (TypeError, ValueError):
                    cet = 0
                if cet == 0:
                    counter += 1
                elif counter == 0:
                    # A continuation with nothing to continue — a hand-edited or truncated
                    # file. Starting a group is the only answer that never yields track 0.
                    self.warnings.append(
                        f"{track_type} lane {lane} continues a Premiere track "
                        f"(currentExplodedTrackIndex={raw}) with none started before it "
                        f"— treated as the start of one")
                    counter += 1
            out.append(counter)

        # totalExplodedTrackCount as a CHECK, never as the driver.
        seen: dict = {}
        want: dict = {}
        for lane, (track, num) in enumerate(zip(tracks, out), start=1):
            seen[num] = seen.get(num, 0) + 1
            raw = track.get("totalExplodedTrackCount")
            if raw is not None and num not in want:
                try:
                    want[num] = int(raw)
                except (TypeError, ValueError):
                    pass
        for num, n_lanes in sorted(seen.items()):
            if num in want and want[num] != n_lanes:
                self.warnings.append(
                    f"{track_type} track {num} is written as {n_lanes} lane(s) but "
                    f"declares totalExplodedTrackCount={want[num]} — grouped by "
                    f"currentExplodedTrackIndex")
        return out

    @staticmethod
    def resolve_transition_edges(track: ET.Element, seq_fps: float = 0.0) -> dict:
        """Timeline bounds for clipitems whose <start>/<end> is -1.

        FCP7 writes -1 for a clipitem boundary that an ADJACENT TRANSITION defines. The
        items of a track are in timeline order, so a -1 start is the preceding
        transitionitem's start and a -1 end is the following transitionitem's end:

            [20] clipitem  IMG_0283   start= 775  end=  -1   in= 217 out= 279
            [21] transitionitem       start= 807  end= 837
            [22] clipitem  scene3.2   start=  -1  end=  -1   in= 949 out=1130
            [23] transitionitem       start= 970  end= 988
            [24] clipitem  scene1-1   start=  -1  end=1063   in= 205 out= 298

        Clip 22 therefore spans 807→988 = 181 frames, exactly its out-in. Clip 24 spans
        970→1063 = 93, clip 20 spans 775→837 = 62 — all three match out-in exactly.

        Until this existed, `duration_frames = end - start` came out zero or negative for
        every such clip and the `--min-frames` filter dropped them WITHOUT A WORD. On one
        real timeline that was 46 clipitems, 3 of them cuttable video and 12 stills: the
        clips were on the timeline, in the XML, and simply absent from the output.

        Returns {id(clipitem element): (start, end)} for the ones that needed resolving.
        """
        # `num(x) or -1` would turn a legitimate ZERO into -1 — and a transition starting
        # on frame 0 is perfectly ordinary. That bug was in this function until a nested
        # sequence under a first-frame dissolve refused to resolve and the new fixture
        # caught it. Read the value, then test it; never lean on truthiness for a number
        # whose valid range includes 0.
        def frame(node, field):
            v = num(node, field, -1)
            if v is None:
                return -1
            # ⚠️ A TRANSITIONITEM'S start/end ARE COUNTED IN ITS OWN <rate>, A CLIPITEM'S
            # ARE NOT. Premiere takes a transitionitem's rate from the media on either side,
            # and it interprets a still at 25 fps by default — so a dissolve between stills
            # on a 30 fps timeline is written at 25 while the clipitems around it are
            # already in sequence frames. Reading the raw integer as a sequence frame put
            # every clip whose edge a transition defines at 25/30 of its true position.
            #
            # PROVED ON REAL DATA, two ways that leave no room for argument. Reading one
            # real export's V2 track in document order: an 'Adjustment Layer' clipitem at
            # 1056-1106, then a rate-30 start-black transition at 1198-1208, then a chain of
            # PNG stills separated by rate-25 transitions starting at 1013. (a) Positions on
            # one track are monotonic in document order, and 1198 followed by 1013 is
            # impossible unless the two are in different units. (b) The unscaled chain
            # 1013-1164 OVERLAPS the Adjustment Layer in the SAME <track> element, which
            # Premiere cannot write. Scaled by 30/25 the chain runs 1198->1419: contiguous,
            # ending exactly on the sequence's last frame, filling the end card that V1 and
            # V7 both run at 1194-1419, no collision.
            #
            # The clipitem half is proved the same way: a rate-25 PNG clipitem with
            # start=1194 end=1419 sits flush against its rate-30 neighbours, so its numbers
            # are ALREADY sequence frames and scaling them would be the mirror bug. Hence
            # the tag guard — it is load-bearing, not defensive.
            #
            # MEASURED HERE on 46 unique real exports: 145 of their 1281 transitionitems
            # declare a rate that is not the sequence's, in 12 of the 46. Diffing the cut
            # list before and after, 133 cuts move — by up to 260 frames, 8.7 s at 30 fps —
            # 11 cuts that were dropped entirely come back, and NOTHING is lost. The 11 are
            # the first clip of each chain: its start came from a correctly-rated
            # start-black fade and its end from a 25 fps centre dissolve, so the resolved
            # start landed AFTER the resolved end, the guard below rejected the pair, and
            # the engine's own warning said "no transition beside it to take one from" —
            # false, the transition is the immediately preceding sibling. The other 34
            # exports are byte-identical.
            if seq_fps > 0 and node.tag == "transitionitem":
                own = parse_rate(node.find("rate"), seq_fps)
                if own > 0 and abs(own - seq_fps) > 1e-9:
                    v = v * seq_fps / own
            return int(round(v))

        kids = [k for k in track if k.tag in ("clipitem", "transitionitem")]
        fixed: dict = {}
        for i, node in enumerate(kids):
            if node.tag != "clipitem":
                continue
            start = frame(node, "start")
            end = frame(node, "end")
            if start >= 0 and end >= 0:
                continue
            if start < 0:
                for j in range(i - 1, -1, -1):
                    if kids[j].tag == "transitionitem":
                        start = frame(kids[j], "start")
                        break
            if end < 0:
                for j in range(i + 1, len(kids)):
                    if kids[j].tag == "transitionitem":
                        end = frame(kids[j], "end")
                        break
            # Only claim a fix when BOTH ends are now real and the span is positive.
            # A -1 with no transition beside it is something else, and guessing at it
            # would be worse than reporting it.
            if start >= 0 and end > start:
                fixed[id(node)] = (start, end)
        return fixed

    def _collect_transitions(self, track: ET.Element, seq_fps: float = 0.0) -> list[dict]:
        out = []
        for tr in track.findall("transitionitem"):
            # ⚠️ THE SAME RATE CONVERSION resolve_transition_edges does, and it is not
            # optional: these values feed the transition_in / transition_out columns, and
            # with resolve_transition_edges patched alone two of the real export's stills
            # lost their labels entirely ('Cross Dissolve' -> ''), because the transition
            # was no longer found beside the clip's corrected position.
            _k = 1.0
            if seq_fps > 0:
                _own = parse_rate(tr.find("rate"), seq_fps)
                if _own > 0 and abs(_own - seq_fps) > 1e-9:
                    _k = seq_fps / _own
            out.append({
                "start": int(round((num(tr, "start", 0) or 0) * _k)),
                "end": int(round((num(tr, "end", 0) or 0) * _k)),
                "alignment": txt(tr, "alignment"),
                "name": txt(tr, "effect/name") or txt(tr, "effect/effectid") or "transition",
            })
        return out

    def _parse_nested(self, clip, track_type, t_idx, depth: int,
                      edges: Optional[dict] = None,
                      premiere_track: Optional[int] = None,
                      parent_fps: Optional[float] = None) -> list[Cut]:
        """Resolve a clipitem that contains a <sequence> instead of a <file>.

        The cuts are inside the nest; what the parent timeline contributes is a window
        (<in>/<out>), a position (<start>/<end>), and possibly its own speed. So each
        inner cut is kept only if it is visible through that window, trimmed to it, and
        re-expressed in parent time.

        ASSUMPTION, stated because it is the one that could be wrong: a nest's
        <in>/<out> are read in the CLIPITEM's rate, exactly as a file clipitem's are —
        Premiere conforms both to the parent sequence rate. Inner clipitems' own
        <start>/<end> are read in the NESTED sequence's rate. That is self-consistent
        and verified against the fixture.

        MEASURED against a real Premiere export as of 2026-08-20 (a client timeline
        using one nest twice): the reference spelling is confirmed — see
        _register_sequence — and both instances live inside a clipitem, so neither shows
        up in the --sequence picker. What is still NOT measured is the RATE assumption in
        the paragraph above: that export's nest runs at the parent's 30 fps, so a nest
        with a different timebase would not have exercised it.

        EVERY inner video track contributes, flattened onto the parent clipitem's track
        index. This function is only reached at all when nest_mode is "all"; render mode's
        default collapses a nest to one cut in _parse without coming here. An inner-V1-only
        variant existed for part of one day and was deleted on measurement — the note on
        Timeline.nest_mode records why, and nothing in this function should reintroduce it.
        """
        seq = clip.find("sequence")
        name = txt(clip, "name") or txt(seq, "name") or "Nested Sequence"
        if depth > MAX_NEST_DEPTH:
            self.warnings.append(f"{name}: nested deeper than {MAX_NEST_DEPTH} levels "
                                 f"— those cuts are not extracted")
            return []

        # ⚠️ RESOLVED HERE, BEFORE ANYTHING IS READ OUT OF `seq`. A bare
        # <sequence id="…"/> has no <rate> either, so reading the nest's frame rate off the
        # placeholder would silently fall back to the parent's and shift every inner cut on
        # a nest whose timebase differs. The body is swapped in first; from this point on
        # `seq` is the definition and everything below is unchanged.
        #
        # The WINDOW still comes from `clip` — start/end/in/out and the nest's own retime
        # are the reference clipitem's own, and they are the whole reason the second
        # instance is not a duplicate of the first.
        seq_ref_id = seq.get("id", "")
        if seq.find("media") is None and seq_ref_id:
            defn = self.sequences.get(seq_ref_id)
            # `is not seq` so a body-less element can never resolve to itself.
            if defn is not None and defn is not seq:
                seq = defn

        nest_fps = parse_rate(seq.find("rate"), self.sequence_fps)
        clip_fps = parse_rate(clip.find("rate"), self.sequence_fps)
        nest_start = num(clip, "start", 0) or 0
        nest_end = num(clip, "end", 0) or 0
        # A NEST can sit under a transition too, and then its own start/end are -1 like any
        # other clipitem. Both -1 used to mean "skipped" — losing every clip inside it, on a
        # timeline where the nest is plainly there. Same sentinel, same resolution.
        if edges:
            fixed = edges.get(id(clip))
            if fixed:
                nest_start, nest_end = fixed
        nest_in = num(clip, "in", 0) or 0
        nest_out = num(clip, "out", 0) or 0
        if nest_out <= nest_in:
            self.warnings.append(f"{name}: nest has no visible range — skipped")
            return []

        span = nest_out - nest_in
        if nest_start < 0 and nest_end >= 0:      # edge under a transition
            nest_start = nest_end - span
        elif nest_end < 0 and nest_start >= 0:
            nest_end = nest_start + span
        if nest_start < 0:
            self.warnings.append(f"{name}: nest has no usable timeline position — skipped")
            return []

        nest_speed, nest_rev, nest_varies, nest_span, _ = read_timeremap(clip)
        if nest_varies:
            self.warnings.append(f"{name}: the NEST itself has a keyframed ramp "
                                 f"({nest_span}) — treated as constant {nest_speed:g}%")
        k_nest = (nest_speed / 100.0) or 1.0

        media = seq.find("media")
        section = media.find(track_type) if media is not None else None
        if section is None:
            # ⚠️ THIS USED TO BE A BARE `return []`. No warning, no _skip — a nest could
            # contribute ZERO cuts and look exactly like a nest that had nothing in it.
            # That is what a panel reading "62 video clips as Premiere counts them ·
            # 56 cut(s) read" was: Premiere counts a nest as ONE clip, so fewer cuts than
            # clips is arithmetically impossible unless the nests yielded nothing.
            #
            # ⚠️ TWO CAUSES, TWO SENTENCES, and conflating them cost an hour of someone's
            # day. The first wording said "has no video track" for a nest that plainly had
            # six of them — the definition simply lived on the other instance of the same
            # nest. `media is None` here means the body was never found, which after the
            # resolution above can only mean an unresolved REFERENCE; anything else is a
            # definition that genuinely has no section for this track type.
            if media is None:
                self.warnings.append(
                    f"{name}: reference to sequence "
                    f"id={seq_ref_id or '(none)'} with no definition in this XML "
                    f"— it contributed no cuts")
                self._skip("a nested sequence reference whose definition is not in "
                           "this XML", name)
            else:
                self.warnings.append(
                    f"{name}: the nested sequence has no <{track_type}> section "
                    f"— it contributed no cuts")
                self._skip(f"a nested sequence with no <{track_type}> section", name)
            return []

        # The visible window inside the nested timeline, in seconds.
        #
        # ⚠️ <in>/<out> ON A RETIMED CLIPITEM ARE PRE-REMAP TIMELINE FRAMES, NOT NEST
        # FRAMES — the same thing the note at the top of this file already records for
        # file clipitems, and the reason `win_hi = nest_out / clip_fps` dropped the tail of
        # every sped-up nest. The frames a nest instance actually consumes are
        # (end - start) * speed/100; on a 140.9% nest the old window was short by exactly
        # that factor and every inner clip past it was discarded by the `hi - lo <= 1e-9`
        # test below, in silence.
        #
        # MEASURED ON REAL EXPORTS, not reasoned: across 60 real Premiere exports holding
        # 57 retimed nest instances, `out - in` equals `end - start` on every instance with
        # real start/end, while (pproTicksOut - pproTicksIn) converted to nest frames equals
        # (end - start) * speed/100 EXACTLY. Shipping 3.58 left 1,539 parent frames of
        # finished edit covered by no cut across 26 of those 60 exports — and the set of
        # exports with a gap was exactly the set with a retimed nest.
        #
        # The ticks are preferred over the k_nest arithmetic because Premiere's own <speed>
        # is a ROUNDED percentage (140.937, 178.808, 43.8356): the ticks are the number it
        # rounded, so they land on the frame the nest really ends on. `_to > _ti` is the
        # guard for an export that carries neither.
        win_lo = nest_in / clip_fps
        win_hi = win_lo + (nest_out - nest_in) / clip_fps * k_nest
        _ti = num(clip, "pproTicksIn", None)
        _to = num(clip, "pproTicksOut", None)
        if _ti is not None and _to is not None and _to > _ti:
            win_lo = _ti / PPRO_TICKS_PER_SECOND
            win_hi = _to / PPRO_TICKS_PER_SECOND
        # ⚠️ THE CALLER'S RATE, NOT THE TOP-LEVEL ONE. A nest inside a nest is positioned in the
        # frames of the nest that CONTAINS it, at that nest's rate — so its <start> divided by the
        # sequence rate was the wrong time base whenever the two differ, and its cuts then
        # skipped the window below entirely (see the `cands` loop). Measured: an outer nest at
        # [100,160) and [300,330) holding an inner nest holding one shot produced ONE cut at
        # [0,60) — nothing at either real position — and a "merged into an identical earlier
        # cut" warning for the second instance. On a real export the instance that showed the
        # deep shots held 0 cuts before this and 6 after; 8 real exports carry that shape.
        pfps = parent_fps or self.sequence_fps
        parent_lo_s = nest_start / pfps

        out: list[Cut] = []
        # EVERY inner track, onto the parent's track index. Not the nest's inner V1 alone:
        # see the note on self.nest_mode for the measurement that killed that rule. The
        # consequence to be aware of rather than surprised by is that a nest's stacked
        # layers land on one parent track and therefore overlap, and
        # split_transition_overlaps moves those boundaries as though they were dissolves.
        # On the one real nest available, four of its six overlapping pairs ARE dissolves —
        # the next shot moved up a track under a transition, which is how Premiere writes
        # one — so the splitter is right more often than it is wrong here, and narrowing to
        # one track would have discarded the four correct ones along with the two wrong.
        inner_clipitems = 0
        outside_window = 0
        # Inner clipitems that are themselves nests and came back with nothing. They are
        # NOT a window question, and every path that returns [] above has already appended
        # a warning saying which one it was — see the report at the bottom.
        nested_empty = 0
        for track in section.findall("track"):
            # The nest's OWN tracks have the same eye/mute toggle as the parent
            # sequence's, and an inner layer switched off is just as much material the
            # editor removed. Applied to everything this track contributes, including a
            # nest-inside-a-nest.
            inner_track_on = txt(track, "enabled", "TRUE").strip().upper() != "FALSE"
            inner_level, inner_level_kf = read_audio_level(track)
            transitions = self._collect_transitions(track, nest_fps)
            edges = self.resolve_transition_edges(track, nest_fps)
            for inner in track.findall("clipitem"):
                inner_clipitems += 1
                if inner.find("sequence") is not None:
                    # `edges` here is THIS track's map, rebuilt two lines above — the
                    # inner nest lives in this track, so those are the -1 boundaries it
                    # needs. Not forwarding them is why a nest-inside-a-nest with a
                    # transition on both sides had start = end = -1, could not be
                    # positioned, and was dropped with "no usable timeline position".
                    _deeper = self._parse_nested(inner, track_type, t_idx, depth + 1,
                                                 edges=edges,
                                                 premiere_track=premiere_track,
                                                 parent_fps=nest_fps)
                    _mark_track_enabled(_deeper, inner_track_on)
                    _mark_audio_level(_deeper, inner_level, inner_level_kf)
                    if not _deeper:
                        nested_empty += 1
                    cands = _deeper
                else:
                    # The nest's inner cuts report the PARENT's track, both the lane ordinal and
                    # the Premiere number — they are placed on the parent's timeline, so the
                    # parent's track is where they live.
                    c = self._parse_clipitem(inner, track_type, t_idx, transitions,
                                             seq_fps=nest_fps, edges=edges,
                                             premiere_track=premiere_track)
                    if c is None:
                        continue
                    _mark_track_enabled([c], inner_track_on)
                    _mark_audio_level([c], inner_level, inner_level_kf)
                    c.lane_count = _lane_count(track)
                    cands = [c]
                # ⚠️ ONE WINDOW PASS FOR BOTH KINDS OF INNER ITEM. A plain clipitem and the cuts
                # that came back from a deeper nest are the same thing at this point: cuts
                # expressed in THIS nest's time, at nest_fps. The deeper ones used to be
                # appended and `continue`d past the window, trim and re-expression that every
                # direct clipitem gets — so they were never clipped to what this instance shows
                # and never moved to where this instance sits.
                for c in cands:

                    a = c.timeline_in_frames / nest_fps      # inner extent, nest seconds
                    b = c.timeline_out_frames / nest_fps
                    lo, hi = max(a, win_lo), min(b, win_hi)
                    if hi - lo <= 1e-9:
                        # ⚠️ COUNTED, NOT JUST SKIPPED. Falling outside the window is a real and
                        # ordinary thing — a nest is usually trimmed — but until this the only
                        # report was the all-or-nothing advisory below, which fires only when a
                        # nest yields ZERO cuts. That silence is why a window that was wrong by
                        # the speed factor deleted 1,539 parent frames of finished edit across
                        # 26 real exports without anything anywhere saying so.
                        outside_window += 1
                        continue                             # scrolled out of the window

                    head = lo - a
                    tail = b - hi
                    if head > 1e-9 or tail > 1e-9:
                        c.nested_trimmed = ("both" if head > 1e-9 and tail > 1e-9
                                            else "head" if head > 1e-9 else "tail")
                        # Trim the source range by the same amount of material, scaled by
                        # the inner clip's own speed. A reversed clip is consumed from the
                        # far end, so its head trim comes off the tail of the source range.
                        #
                        # ⚠️ 3.93 AUDIT · AND ITS TAIL TRIM COMES OFF THE START. A reversed
                        # clip shows its source END first, so what a window cuts off at its
                        # nest-time tail is the START of the source range. Only the length
                        # was taken off, so the in-point stayed put and the clip delivered
                        # the part of the source the window hides: MEASURED on 3.93, inner
                        # clip over source 100..159 reversed, window 0-30 -> delivered
                        # 129..100 where the timeline shows 159..130, status ok, and the
                        # window 30-60 delivered the very same frames.
                        k_in = (c.speed_percent / 100.0) or 1.0
                        if c.reversed:
                            c.source_in_seconds += tail * k_in
                            c.source_duration_seconds -= (head + tail) * k_in
                        else:
                            c.source_in_seconds += head * k_in
                            c.source_duration_seconds -= (head + tail) * k_in
                        if c.source_duration_seconds <= 0:
                            continue
                        if c.source_fps > 0:
                            c.source_consumed_frames = consumed_frames(
                                c.source_in_seconds, c.source_duration_seconds,
                                c.source_fps)

                    # re-express in parent time
                    vis = (hi - lo) / k_nest
                    # ⚠️ A REVERSED NEST MIRRORS ITS WINDOW, and the offset is the whole of
                    # it: what sits at the END of the window is what plays FIRST. Without
                    # this term every inner cut kept its forward position — measured on a
                    # four-shot nest reversed at 100%, the shot the timeline plays first was
                    # placed last and the ordinal prefixes ran 01..04 backwards, with no
                    # warning anywhere. The CONTENTS were already right (the source range is
                    # untouched and c.reversed is set below), so what this moves is the
                    # position, the timecodes and the numbering. Rare — 0 reversed nests in
                    # 91 real exports holding 284 nest clipitems — but silent when it hits.
                    off = (win_hi - hi) if nest_rev else (lo - win_lo)
                    p_in = parent_lo_s + off / k_nest
                    c.timeline_in_frames = int(round(p_in * pfps))
                    c.timeline_out_frames = int(round((p_in + vis) * pfps))
                    c.duration_frames = max(1, c.timeline_out_frames - c.timeline_in_frames)
                    c.timeline_in_tc = frames_to_tc(c.timeline_in_frames, pfps)
                    c.timeline_out_tc = frames_to_tc(c.timeline_out_frames, pfps)
                    c.duration_seconds = round(vis, 6)

                    # the nest's own retime compounds with the clip's
                    c.speed_percent = round(c.speed_percent * nest_speed / 100.0, 6)
                    c.reversed = bool(c.reversed) != bool(nest_rev)   # both = forwards again
                    c.speed_varies = c.speed_varies or nest_varies
                    c.nested_from = name
                    out.append(c)

        # The nest clipitem's own fader rides on everything inside it, the same way a
        # track's does — a nest is a submix, and Premiere lets you pull it down as one.
        _mark_audio_level(out, *read_audio_level(clip))

        # ⚠️ 3.93 AUDIT · AND SO DOES ITS OWN ENABLE SWITCH. The nest clipitem's <enabled>
        # was never read here — only the enclosing track's toggle, applied by the caller —
        # so every shot inside a nest switched off on the timeline came back enabled:
        # MEASURED on 3.93, delivered to raw/ as `ok` in Source Render, and its voice-over
        # mixed into _timeline_audio.mp3 in both modes (this function is the mix's walk too,
        # see _nest_audio_for_mix) while the run said the clip was NOT cut. A clip switched
        # off is `enabled` False with `track_enabled` left alone, so the --disabled drop,
        # its counts ("switched off", not "on a muted track") and the audio filter all
        # treat these as the clip-level switch they are.
        if txt(clip, "enabled", "TRUE").strip().upper() == "FALSE":
            for c in out:
                c.enabled = False

        # ⚠️ PER NEST INSTANCE, not only when the whole nest yields nothing. A nest that
        # gives back SOME cuts and drops others looked identical to a nest that gave back
        # everything, and that is the exact shape the retimed-window defect wore for years:
        # 14 cuts came out, two stills did not, and `completeness` still read "all 88 cuts
        # on the timeline". A future window that is wrong again will at least say so.
        if out and outside_window:
            self.warnings.append(
                f"{name}: {outside_window} of {inner_clipitems} clipitem(s) inside the "
                f"nest fall outside the window this instance shows "
                f"({win_lo:.3f}-{win_hi:.3f}s in nest time) — not cut")

        if not out:
            # ⚠️ IN THE NEW TERMS. This used to be able to mean "its shots are on a track
            # --nest resolve refused to look at", and the message that said so is gone
            # along with the rule. Every inner track is walked now, so there are only two
            # ways to end up here and they want different actions from the reader.
            if inner_clipitems == 0:
                self.warnings.append(
                    f"{name}: the nest holds no clipitems on any {track_type} track "
                    f"— nothing to cut")
            elif nested_empty >= inner_clipitems:
                # ⚠️ SILENT ON PURPOSE, AND THIS IS THE ONE PLACE THAT MAY BE. Everything
                # inside this nest is another nest that gave nothing back and said why
                # itself, so a window sentence here would be a FALSE second explanation of
                # a cause already stated. MEASURED on a five-deep nest against a cap of 4:
                # one true "nested deeper than 4 levels" line followed by four
                # "fall outside the window" lines contradicting it, in the console, the
                # panel's notes rail and the manifest — the clipitems were inside their
                # windows and were lost to the depth cap.
                pass
            else:
                _out_of = inner_clipitems - nested_empty
                _head = (f"all {inner_clipitems}" if not nested_empty
                         else f"{_out_of} of {inner_clipitems}")
                self.warnings.append(
                    f"{name}: {_head} clipitem(s) inside the nest fall "
                    f"outside the window this instance shows (in/out "
                    f"{nest_in:g}-{nest_out:g} in nest frames) — no cuts")
        return out

    def _skip(self, why: str, name: str = "") -> None:
        """Record a clipitem that did not become a cut.

        Every one of these used to be a bare `return None`. Individually defensible;
        collectively they meant "my export has fewer clips than my timeline" had eight
        possible causes and only two of them said anything. The -1 transition bug hid here
        for weeks.
        """
        e = self.skipped.setdefault(why, {"count": 0, "names": []})
        e["count"] += 1
        if name and len(e["names"]) < 4 and name not in e["names"]:
            e["names"].append(name)

    def _parse_clipitem(self, clip, track_type, t_idx, transitions,
                        seq_fps: Optional[float] = None,
                        edges: Optional[dict] = None,
                        premiere_track: Optional[int] = None) -> Optional[Cut]:
        # seq_fps overrides the sequence rate when this clipitem lives inside a nested
        # sequence — its timeline positions are counted in the NEST's rate, not the
        # parent's, and conflating the two shifts every nested cut.
        seq_fps = self.sequence_fps if seq_fps is None else seq_fps
        # ⚠️ NO MEDIA IS NOT THE SAME AS NOTHING TO CUT — that depends on the mode, and
        # the parser cannot know it. Both cases below used to `return None` here, which is
        # why one real timeline of 40 clipitems produced 17 cuts and the reason lived in
        # a warning nobody had to read:
        #
        #   an ADJUSTMENT LAYER or an Essential Graphics TITLE carries a <file> id with no
        #   pathurl, because there is no file on disk. Undecodable, so source mode is right
        #   to refuse it — but Premiere renders it perfectly, and on the master track a
        #   title used as a shot IS a shot.
        #
        #   a SYNTHETIC item (Black Video, Slug, a colour matte) has no <file> at all, and
        #   renders just as happily.
        #
        # So they become cuts marked `unsupported`, which every one of the sixteen places
        # that tests media_kind already handles correctly: refused with a reason in source
        # mode, cuttable once a render exists. Listed and explained instead of silently
        # absent — which is exactly what _skip's own docstring complains about.
        file_node = clip.find("file")
        # A NEST reaching here means --nest one-cut: it is being cut as a single clip
        # spanning its own start/end. It has no file, like a synthetic — but it is not one,
        # and filing it under "no media file" would inflate an advisory that is meant to
        # flag MISSING media with something the user deliberately asked for.
        nest_node = clip.find("sequence")
        fid = ""
        finfo = {}
        no_media = ""
        if file_node is None:
            no_media = ("a nested sequence, cut as one clip"
                        if nest_node is not None
                        else "synthetic (Black Video, Slug or a colour matte)")
        else:
            fid = self._register_file(file_node)
            finfo = self.files.get(fid, {})
            if not finfo.get("path"):
                # Also the shape of the bug fixed in 3.10, where files defined under
                # another sequence were never registered. Counted either way.
                #
                # ⚠️ WORDED AS WHAT THEY ARE, not as what went wrong. This text is what the
                # panel shows on the rail, and "no media file … listed as needing a render"
                # read as 31 broken clips on a real timeline whose 31 titles were perfectly
                # normal. Nothing is wrong with a title; it simply cannot be cut from a
                # source file, because there is no source file — Premiere draws it. Naming
                # the mode that DOES produce them turns the sentence from a complaint into
                # the instruction the reader needs.
                #
                # ⚠️ AND THE INSTRUCTION IS ONLY AN INSTRUCTION IN SOURCE MODE. The same
                # sentence was printed, put on the rail and stored in manifest.warnings on
                # every --render-planned scan and --render-dir export too — measured on a
                # real V1/V2/V3 timeline: "++ 29 clip(s): … so switch to Timeline Render to
                # get them" right under "--render-dir: 20 of 20 cut(s) have a render", and
                # the same on tests/check_flags.py's one-title fixture in both flags. In
                # that mode there is nothing to switch to: a graphic on the master track is
                # cut from its render like any shot, and one above it is already composited
                # into the master track's frames.
                if self.render_mode:
                    no_media = ("they are titles, graphics or adjustment layers, which "
                                "Premiere draws itself — no media file, and none is needed "
                                "in Timeline Render: on the master track they are cut from "
                                "the render, above it they are already in the picture")
                else:
                    no_media = ("they are titles, graphics or adjustment layers, which "
                                "Premiere draws itself — there is no media file to cut "
                                "from, so switch to Timeline Render to get them")
        if no_media:
            # Counted in nests_one_cut and reported by its own advisory instead.
            if nest_node is None:
                self._skip(no_media, txt(clip, "name"))
            finfo = {"path": "", "fps": 0.0}

        start = num(clip, "start", 0) or 0
        end = num(clip, "end", 0) or 0
        c_in = num(clip, "in", 0) or 0
        c_out = num(clip, "out", 0) or 0

        # A -1 boundary is one the adjacent TRANSITION defines; resolve_transition_edges()
        # worked it out from the track's item order. Without this, a clip sitting between
        # two transitions has start = end = -1 and is discarded three lines below —
        # silently, on a timeline where it is plainly present.
        #
        # The RAW values are kept because they are what says "a transition defines this
        # edge". Resolving them and then testing the resolved values lost that fact, and
        # with it the `edge_in_transition` flag — which suppresses a false merge warning
        # and tells the reader the clip carries handle frames under a dissolve.
        raw_start, raw_end = start, end
        if edges:
            fixed = edges.get(id(clip))
            if fixed:
                start, end = fixed

        if start < 0 and end < 0:
            # Still unresolved: no transition beside it to take the boundary from. Guessing
            # would be worse, but vanishing without a word is worst of all — this is exactly
            # the failure that had clips missing from an export with nothing to explain it.
            self.warnings.append(
                f"{txt(clip, 'name') or 'a clip'} on {track_type} track {t_idx} has no "
                f"timeline position (start and end are both -1) and no transition "
                f"beside it — NOT cut")
            return None

        # CRITICAL: <in>/<out> are expressed in the CLIPITEM's rate — which Premiere
        # conforms to the sequence rate — NOT the source file's native rate. A 24 fps
        # file in a 30 fps timeline has in/out counted in 30ths of a second. Using the
        # file's 24 fps here stretches every seek and duration by 30/24 = 1.25x.
        clip_fps = parse_rate(clip.find("rate"), seq_fps)
        file_fps = finfo.get("fps") or clip_fps

        # Timeline length is end-start; on a retimed clip that differs from out-in.
        dur_frames = int(round(end - start)) if (start >= 0 and end >= 0) else 0
        if dur_frames <= 0:
            dur_frames = int(round(c_out - c_in))
        if dur_frames <= 0:
            self._skip("no usable length (neither start/end nor in/out)",
                       txt(clip, "name"))
            return None

        # Premiere writes start or end as -1 when that edge is buried under a
        # transition. Rebuild the real edge from the other side + duration,
        # otherwise the clip sorts to the top with a nonsense timecode.
        # Which edge a transition defines — read from the RAW values, so it is still known
        # after resolve_transition_edges() has filled them in.
        edge = ("both" if (raw_start < 0 and raw_end < 0)
                else "head" if raw_start < 0
                else "tail" if raw_end < 0
                else "")
        # Still unresolved (no transition beside it): fall back to sizing from out-in, as
        # before. The span is right even though the placement is inferred.
        if start < 0 and end >= 0:
            start = end - dur_frames
        elif end < 0 and start >= 0:
            end = start + dur_frames

        ext = Path(finfo["path"]).suffix.lower()
        if no_media:
            # Nothing to decode, whatever the mode thinks about it.
            kind = "unsupported"
        elif ext in UNSUPPORTED_EXT:
            kind = "unsupported"
        elif ext in STILL_EXT:
            kind = "still"
        else:
            kind = "video"

        # speed / reverse / ramp — needed before we can size the source range
        speed, reverse, varies, span_txt, filters = read_timeremap(clip)

        # Prefer Premiere's tick values: they are the source range in absolute
        # seconds, already correct for speed ramps. <in>/<out> on a retimed clip
        # describe the range BEFORE the remap, so trusting them pulls the wrong
        # footage — by over a second on a heavily sped-up shot.
        ticks_in = num(clip, "pproTicksIn", None)
        ticks_out = num(clip, "pproTicksOut", None)
        if ticks_in is not None and ticks_out is not None and ticks_out > ticks_in:
            src_in_sec = ticks_in / PPRO_TICKS_PER_SECOND
            src_dur_sec = (ticks_out - ticks_in) / PPRO_TICKS_PER_SECOND
            timing = "ticks"
        else:
            # A sped-up clip consumes more source than it occupies on the timeline:
            # 300% speed over 40 timeline frames eats 120 frames of source.
            span = int(round(dur_frames * (speed / 100.0))) if speed > 0 else dur_frames
            src_in_sec = frames_to_seconds(c_in, clip_fps)
            src_dur_sec = frames_to_seconds(span, clip_fps)
            timing = "frames"
        # Count consumed material in the SOURCE's native rate, not the sequence's.
        # This column means "how many source frames this clip ate", and it is also
        # what -frames:v pins on output. Using clip_fps here inflated every 24 fps
        # clip in a 30 fps timeline by 30/24 = 1.25x — the clips were correct while
        # the manifest describing them was not. Refined again after ffprobe, which
        # knows the real rate better than the XML does.
        consumed = consumed_frames(src_in_sec, src_dur_sec, file_fps)

        cut = Cut(
            clip_name=txt(clip, "name") or finfo.get("name", "clip"),
            track_type=track_type,
            track_index=t_idx,
            premiere_track=int(t_idx if premiere_track is None else premiere_track),
            timeline_in_frames=int(start),
            timeline_out_frames=int(end),
            timeline_in_tc=frames_to_tc(start, seq_fps),
            timeline_out_tc=frames_to_tc(end, seq_fps),
            source_in_frames=int(c_in),
            source_out_frames=int(c_out),
            source_in_tc=frames_to_tc(c_in, clip_fps),
            source_out_tc=frames_to_tc(c_out, clip_fps),
            # FULL PRECISION on purpose — these two drive the ffmpeg seek. Rounding
            # them to 6dp here cost a whole frame: 137/24 stored as 5.708333 comes
            # back as frame 136.999992, which floors to 136 and starts the cut one
            # frame early. Rounding happens at manifest-write time instead.
            source_in_seconds=src_in_sec,
            source_duration_seconds=src_dur_sec,
            timing_source=timing,
            duration_frames=dur_frames,
            duration_seconds=round(frames_to_seconds(dur_frames, seq_fps), 6),
            source_consumed_frames=consumed,
            source_path=finfo["path"],
            source_exists=os.path.isfile(finfo["path"]),
            file_id=fid,
            # ⚠️ FULL PRECISION, for the reason the two seconds fields above are — see
            # RATE_FIELDS. Rounded here, 30000/1001 is stored 1e-9 high and every frame index
            # the cut arithmetic derives from it drifts by k * 1e-9.
            source_fps=file_fps,
            speed_percent=speed,
            reversed=reverse,
            speed_varies=varies,
            speed_span=span_txt,
            filters=filters,
            enabled=txt(clip, "enabled", "TRUE").upper() != "FALSE",
            edge_in_transition=edge,
            media_kind=kind,
        )
        # The clip's OWN fader. Enclosing tracks and nests multiply theirs in afterwards,
        # at the emit sites — see _mark_audio_level.
        cut.audio_level, cut.audio_level_varies = read_audio_level(clip)
        if varies:
            self.warnings.append(
                f"{cut.clip_name}: keyframed speed ramp ({span_txt}) treated as a "
                f"constant {speed:g}% — the range is right, the retime is not")

        # A still's <in>/<out> are an arbitrary offset into a virtual 24h clip;
        # only the timeline duration is meaningful.
        if kind == "still":
            cut.source_in_seconds = 0.0
            cut.source_duration_seconds = frames_to_seconds(dur_frames, seq_fps)
            cut.source_consumed_frames = dur_frames
            cut.timing_source = "timeline"

        # adjacent transitions
        for tr in transitions:
            if abs(tr["end"] - cut.timeline_in_frames) <= 1 or (
                tr["start"] <= cut.timeline_in_frames <= tr["end"]
            ):
                cut.transition_in = tr["name"]
            if abs(tr["start"] - cut.timeline_out_frames) <= 1 or (
                tr["start"] <= cut.timeline_out_frames <= tr["end"]
            ):
                cut.transition_out = tr["name"]

        if track_type == "audio":
            try:
                cut.source_track = max(1, int(num(clip, "sourcetrack/trackindex", 1) or 1))
            except (TypeError, ValueError):
                cut.source_track = 1
            # Not for a nest cut as ONE clip: it is never mixed (its inner audio is, see
            # _nest_audio_for_mix, and that does not carry the nest's own fades), so a fade it
            # claimed would vanish without the "could not be placed" note resolve mode gives.
            if clip.find("sequence") is None:
                cut.audio_fades = audio_fades_for(cut, transitions, seq_fps)

        return cut


# --------------------------------------------------------------------------
# Panel dump input — the same cut list, read from Premiere instead of an XML
# --------------------------------------------------------------------------

class DumpTimeline:
    """A Timeline built from the Raw-cutter panel's JSON instead of an XML.

    Deliberately duck-types `Timeline`: same attribute names, same `Cut` objects, so
    every downstream stage — naming, probing, building the ffmpeg command, the
    manifest — runs unchanged and stays covered by the same reasoning.

    What the panel gives that an XML cannot:

      * the INTERPRETED frame rate, which is what Premiere actually cut against
      * keyframed speed ramps, reported per clip rather than flattened to one number
      * real media paths — Premiere's LAST KNOWN ones, which is not the same as present

    What it cannot give: the contents of a nested sequence. Premiere hands the nest
    over as a single clip, and resolving it would mean re-deriving the nest walking
    that the XML path already does. Nests are reported and skipped, never guessed at.
    """

    # A WIRE VALUE, not a display name. host.jsx stamps it into every dump and
    # looks_like_dump() validates it, so renaming it would make every dump already on
    # disk unreadable. The product name lives in NAME.
    GENERATOR = "xmlcut reader"

    def __init__(self, dump_path: Path, remaps: Optional[list] = None):
        self.xml_path = dump_path
        # ⚠️ --remap APPLIES HERE TOO, and it used to be dropped on the floor. The docstring
        # said a dump's "real media paths" left --remap nothing to do, but host.jsx records
        # getMediaPath() — Premiere's last-known path — alongside is_offline, so an offline
        # clip arrives with exactly the stale path a remap exists to fix. The panel's
        # dump-only fallback (the XML export failed) still offers "find the media for N
        # cuts", verifies the files in the folder the editor picks, and sends --remap; the
        # engine then ignored it. MEASURED on tests/panel_dump.json with CAM_A moved to
        # /Volumes/Gone: `--remap /Volumes/Gone/=<testmedia>/` on the dump still printed
        # "5 cut(s) reference media that isn't at the recorded path … Fix with --remap
        # OLD=NEW", the advice the run had already taken, with CAM_A still missing.
        self.remaps = list(remaps or [])
        self.cuts: list[Cut] = []
        # Same attribute as the XML timeline carries, so the voice-over mix does not have to
        # know which of the two it was handed. Filled only if the dump has audio items in it.
        self.audio_items: list[Cut] = []
        self.markers: list[dict] = []
        self.warnings: list[str] = []
        self.available_sequences: list[dict] = []
        self.sequence_name = ""
        self.sequence_id = ""
        self.sequence_fps = 25.0
        # ⚠️ WHAT THE AUDIO A-NUMBERS ACTUALLY MEAN ON THIS PATH, and it
        # defaults to "unknown" ON PURPOSE. The manifest used to hardcode "premiere",
        # so the dump path advertised Premiere numbering while having applied none of
        # it — a field that lies is worse than a field that is absent. Each path
        # opts in beside the code that does the work, so a new one that forgets says
        # "unknown" rather than claiming credit.
        self.audio_numbering = "unknown"
        # The sequence's own frame size, from <media><video><format>. Needed because
        # a RENDER is the sequence, not the source: for a cut with no source file to
        # read, these are the only honest dimensions to price an output from.
        self.sequence_width = 0
        self.sequence_height = 0
        self.sequence_duration_frames = 0
        self._load(dump_path)

    # ONE rewrite rule for both inputs, not a copy of it: the whole-folder match and the
    # first-pair-wins rule in Timeline._resolve were each paid for with a measured
    # mis-rewrite, and a second implementation is where the next one would come from.
    _resolve = Timeline._resolve

    @staticmethod
    def looks_like_dump(path: Path) -> bool:
        """Cheap sniff so the CLI can accept either input without a mode flag."""
        try:
            if path.suffix.lower() != ".json":
                return False
            with open(path, "r", encoding="utf-8") as fh:
                return DumpTimeline.GENERATOR in fh.read(400)
        except Exception:
            return False

    @staticmethod
    def _ticks(node) -> Optional[int]:
        """Ticks arrive as a STRING — the values exceed float precision."""
        if not isinstance(node, dict):
            return None
        v = node.get("ticks")
        if v in (None, ""):
            return None
        try:
            return int(str(v))
        except (TypeError, ValueError):
            return None

    def _load(self, path: Path) -> None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise SystemExit(f"error: no such file: {path}")
        except json.JSONDecodeError as e:
            raise SystemExit(f"error: {path.name} is not readable JSON ({e})")
        if data.get("generator") != self.GENERATOR:
            raise SystemExit(
                f"error: {path.name} was not written by the Raw-cutter panel.")

        seq = data.get("sequence") or {}
        self.sequence_name = str(seq.get("name") or "Untitled Sequence")
        self.sequence_id = _dump_sequence_id(seq)
        fps = seq.get("fps")
        if not isinstance(fps, (int, float)) or fps <= 0:
            tb = seq.get("timebase_ticks_per_frame") or 0
            fps = (PPRO_TICKS_PER_SECOND / tb) if tb else 25.0
        self.sequence_fps = float(fps)

        end_ticks = self._ticks(seq.get("end"))
        if end_ticks:
            self.sequence_duration_frames = int(
                round(end_ticks / PPRO_TICKS_PER_SECOND * self.sequence_fps))

        nests = 0
        for entry in data.get("clips") or []:
            cut = self._build(entry)
            if cut is None:
                nests += 1
                continue
            self.cuts.append(cut)

        # ⚠️ CLAIMED ONLY IF AUDIO WAS ACTUALLY NUMBERED, and that condition is the whole
        # point of the field. The panel walks sequence.audioTracks and passes t + 1, so a
        # clip's track_index on this path IS Premiere's A-number — no exploded per-channel
        # lanes to group, which is why the XML path needs premiere_track_numbers() and this
        # one does not. But a timeline with no audio has had no numbering applied to it, so
        # it says "unknown" rather than taking credit; that is what makes the manifest field
        # a report rather than a constant.
        if any(c.track_type == "audio" for c in self.cuts):
            self.audio_numbering = "premiere"

        # Order the way the XML path does, so indices and filenames line up between
        # the two inputs for the same timeline.
        self.cuts.sort(key=lambda c: (c.track_type != "video", c.timeline_in_frames,
                                      c.track_index))
        # ⚠️ 3.93 AUDIT · AND IDENTIFIED THE WAY THE XML PATH IDENTIFIES THEM. This route is
        # what the panel cuts from when Premiere's XML export fails, and it never assigned a
        # cut_id — so every cut had "", the folder's ledger recorded nothing (record() needs
        # an id), 'skip clips already there' kept nothing, and the tidy had nothing to plan:
        # MEASURED on 3.93, a lift on this route left numbers 01-13 each worn by two files.
        # The same recipe as Timeline._assign_cut_ids, so the ledger, --resume and the tidy
        # work here too. (The dump derives its source range from ticks x speed, so its ids
        # need not equal the XML route's for the same clip: switching a folder between the
        # two routes reads as a relink — same names overwritten, the rest set aside.)
        Timeline._assign_cut_ids(self)
        if nests:
            self.warnings.append(
                f"{nests} nested sequence(s) skipped. Export this timeline as XML to "
                f"cut inside nests.")
        if not self.cuts:
            self.warnings.append("no cuttable clips found in the dump")

    def _build(self, e: dict) -> Optional[Cut]:
        pi = e.get("project_item") or {}
        if pi.get("is_sequence"):
            return None

        path = str(pi.get("media_path") or "")
        path = self._resolve(path)
        ext = Path(path).suffix.lower()
        # ⚠️ NO PATH MEANS NO MEDIA, the same as it does on the XML path (see the `no_media`
        # branch in the clipitem reader). An adjustment layer, a title, a colour matte and a
        # graphic all reach here with media_path "", and classifying them as `video` sent
        # them on as ordinary cuts whose source does not exist: measured on a dump built
        # from the repo fixture, five such clips came out `media_kind video,
        # source_exists False` and the run printed "5 cut(s) reference media that isn't at
        # the recorded path" followed by a BLANK line — the empty path — and advice to fix
        # it with --remap, which cannot apply to a clip that never had a file. The XML path
        # has always called these "no media file (an adjustment layer, a graphic or a
        # title)". This is the dump-only fallback, so it is only reached when the XML export
        # failed, but that is exactly when the messages need to make sense.
        if not path:
            kind = "unsupported"
        elif ext in UNSUPPORTED_EXT:
            kind = "unsupported"
        elif ext in STILL_EXT:
            kind = "still"
        else:
            kind = "video"

        start = self._ticks(e.get("start")) or 0
        end = self._ticks(e.get("end")) or 0
        t_in = int(round(start / PPRO_TICKS_PER_SECOND * self.sequence_fps))
        t_out = int(round(end / PPRO_TICKS_PER_SECOND * self.sequence_fps))
        dur_frames = max(0, t_out - t_in)

        speed_mult = e.get("speed")
        speed = (float(speed_mult) * 100.0
                 if isinstance(speed_mult, (int, float)) and speed_mult else 100.0)
        speed = abs(speed) or 100.0
        k = speed / 100.0

        src_in_t = self._ticks(e.get("in_point"))
        src_out_t = self._ticks(e.get("out_point"))
        if src_in_t is None or src_out_t is None or src_out_t <= src_in_t:
            src_in_sec = 0.0
            src_dur_sec = frames_to_seconds(dur_frames, self.sequence_fps)
            timing = "timeline"
        else:
            # MUST be scaled by speed. Premiere's TrackItem inPoint/outPoint are in
            # TIMELINE units, not source units: on a 115.126% clip their difference is
            # the 1.600s the clip occupies, not the 1.842s of source it consumes.
            # Measured across a real 39-cut timeline: out-in equalled the timeline
            # length on 16 clips and the consumed source range on none, while
            # (value x speed) reproduced the XML's in-point and duration exactly.
            #
            # This is NOT the same as pproTicksIn/Out, which do span the consumed
            # range. Taking these raw made every retimed cut short by (1 - 1/speed).
            src_in_sec = (src_in_t / PPRO_TICKS_PER_SECOND) * k
            src_dur_sec = ((src_out_t - src_in_t) / PPRO_TICKS_PER_SECOND) * k
            timing = "ticks"

        # Premiere's interpreted rate, which beats both the XML's <file><rate> and
        # ffprobe: it is the rate the edit was actually built against. apply_probe
        # would otherwise overwrite this from the file, so it is pinned below.
        # usable_fps, not `> 0`: see its docstring for why a 1e-7 rate is poison.
        src_fps = usable_fps((e.get("interpretation") or {}).get("frame_rate"))

        name = str(e.get("name") or pi.get("name") or "clip")
        ramp = bool(e.get("has_keyframed_remap"))
        span_txt = ""
        if ramp:
            vals = [k.get("value") for comp in (e.get("components") or [])
                    if comp.get("is_time_remap")
                    for p in (comp.get("params") or [])
                    for k in (p.get("keys") or [])
                    if isinstance(k.get("value"), (int, float))]
            if vals:
                span_txt = f"{min(vals) * 100:g}–{max(vals) * 100:g}%"

        cut = Cut(
            clip_name=name,
            track_type=str(e.get("track_type") or "video"),
            track_index=int(e.get("track_index") or 1),
            # ⚠️ THE DUMP PATH USED TO LEAVE THIS AT ITS DEFAULT OF 1, and main() reads
            # ONLY premiere_track for the audio menu and the --audio-tracks filter. So four
            # real audio tracks were advertised as one, and asking for A2 selected nothing
            # and mixed silence — while the manifest went on publishing
            # "audio_track_numbering": "premiere".
            #
            # On this path track_index ALREADY IS the Premiere A-number: the panel walks
            # sequence.audioTracks and passes t + 1 (panel/jsx/host.jsx), so there are no
            # exploded per-channel lanes to group. That is why the XML path needs
            # premiere_track_numbers() and this one does not.
            premiere_track=int(e.get("track_index") or 1),
            timeline_in_frames=t_in,
            timeline_out_frames=t_out,
            timeline_in_tc=frames_to_tc(t_in, self.sequence_fps),
            timeline_out_tc=frames_to_tc(t_out, self.sequence_fps),
            source_in_seconds=src_in_sec,
            source_duration_seconds=src_dur_sec,
            timing_source=timing,
            duration_frames=dur_frames,
            duration_seconds=round(frames_to_seconds(dur_frames, self.sequence_fps), 6),
            source_path=path,
            source_exists=bool(path) and os.path.isfile(path),
            file_id=str(pi.get("node_id") or ""),
            source_fps=src_fps,                 # full precision — see RATE_FIELDS
            interpreted_fps=round(src_fps, 6),
            speed_percent=speed,
            reversed=bool(e.get("reversed")),
            speed_varies=ramp,
            speed_span=span_txt,
            enabled=not bool(e.get("disabled")),
            media_kind=kind,
            filters=[str(c.get("displayName") or "")
                     for c in (e.get("components") or [])
                     if c.get("displayName") not in (None, "", "Opacity")],
        )
        if src_fps > 0:
            cut.source_in_frames = int(round(src_in_sec * src_fps))
            cut.source_out_frames = int(round((src_in_sec + src_dur_sec) * src_fps))
            cut.source_in_tc = frames_to_tc(cut.source_in_frames, src_fps)
            cut.source_out_tc = frames_to_tc(cut.source_out_frames, src_fps)
            cut.source_consumed_frames = consumed_frames(src_in_sec, src_dur_sec, src_fps)

        if kind == "still":
            cut.source_in_seconds = 0.0
            cut.source_duration_seconds = frames_to_seconds(dur_frames,
                                                            self.sequence_fps)
            cut.source_consumed_frames = dur_frames
            cut.timing_source = "timeline"

        if ramp:
            self.warnings.append(
                f"{name}: keyframed speed ramp ({span_txt or 'varies'}) — the range is "
                f"right, a uniform retime is not")

        # The invariant that catches a wrong reading of the API before it becomes a
        # wrong file: source length / speed should equal the length on the timeline.
        # If Premiere's inPoint/outPoint ever stopped spanning the CONSUMED range,
        # this is where it would surface, loudly, instead of silently mis-cutting.
        if kind == "video" and timing == "ticks" and dur_frames > 0 and not ramp:
            want = frames_to_seconds(dur_frames, self.sequence_fps)
            got = src_dur_sec / (speed / 100.0)
            if abs(got - want) > max(0.05, want * 0.02):
                self.warnings.append(
                    f"{name}: source range {src_dur_sec:.3f}s at {speed:g}% implies "
                    f"{got:.3f}s but it occupies {want:.3f}s — length unverified")
        return cut


class _TickBuckets(dict):
    """The dump's clips by start tick, with the ticks kept sorted for match_dump_clip.
    Filled with setdefault() only, which is the one way overlay_dump() adds to it."""

    def __init__(self):
        super().__init__()
        self._rank: dict = {}
        self._sorted: list = []

    def setdefault(self, key, default=None):
        if key not in self:
            self._rank[key] = len(self._rank)
            bisect.insort(self._sorted, key)
        return super().setdefault(key, default)

    def near(self, want, slack) -> list:
        lo = bisect.bisect_left(self._sorted, want - slack) - 1
        hi = bisect.bisect_right(self._sorted, want + slack) + 1
        hits = [t for t in self._sorted[max(0, lo):hi] if abs(t - want) <= slack]
        return sorted(hits, key=self._rank.__getitem__)


def match_dump_clip(buckets: dict, want_ticks: int, slack: float,
                    source_path: str) -> tuple:
    """Find the panel clip that is the same clip as an XML cut.

    Position alone is not an identity on a real timeline: graphics, titles and
    adjustment layers sit at the same start ticks as the footage beneath them, so a
    tick can name half a dozen clips. The media filename settles it — a cut and the
    panel clip it came from necessarily reference the same file.

    Returns (clip_or_None, how) where `how` is one of "exact", "byname", "only",
    "ambiguous" or "none", so the caller can report what it could not resolve rather
    than guessing.
    """
    cands = []
    # ⚠️ 3.93 AUDIT · NOT EVERY BUCKET FOR EVERY CUT. This loop visited every start tick of
    # the dump once per XML cut — cuts x starts. MEASURED on 3.93: 5,000 cuts spent most of a
    # 12 s read here, paid on every read and twice in Both. overlay_dump() hands over a
    # _TickBuckets, which keeps its keys sorted: only the keys within the slack are visited
    # (widened by one each side and re-tested with the same predicate, so float rounding at
    # the edges cannot change the answer), in the dict's own insertion order, so the
    # candidates — and therefore byname / only / ambiguous — are exactly what the full scan
    # gives. A plain dict still gets the full scan.
    near = buckets.near(want_ticks, slack) if isinstance(buckets, _TickBuckets) else [
        t for t in buckets if abs(t - want_ticks) <= slack]
    for t in near:
        cands.extend(buckets[t])
    if not cands:
        return None, "none"

    base = os.path.basename(source_path or "").lower()
    if base:
        named = [c for c in cands
                 if os.path.basename(
                     ((c.get("project_item") or {}).get("media_path") or "")
                 ).lower() == base]
        if len(named) == 1:
            return named[0], "byname"
        if named:
            # Same file used twice at the same instant on different tracks. Either is
            # as good as the other: they share the media, which is all the overlay
            # reads that is position-independent.
            return named[0], "byname"

    if len(cands) == 1:
        return cands[0], "only"
    # Several clips here and none of them is this file. Matching one anyway would
    # attach another clip's ramp keys, or repoint this cut at another clip's media.
    return None, "ambiguous"


def _dump_sequence_id(seq) -> str:
    """The `id` a panel dump's sequence block carries — Premiere's sequenceID — or "".

    Only a non-empty string or an integer counts: host.jsx writes String(sequenceID), and
    anything else (null, a bool, a nested object from some other tool) is no identity."""
    if not isinstance(seq, dict):
        return ""
    v = seq.get("id")
    if isinstance(v, bool) or not isinstance(v, (str, int)):
        return ""
    return str(v).strip()


def panel_sequence_id(tl, dump_path: Path) -> str:
    """Premiere's sequenceID for this timeline, off the panel dump --panel names; "" if none.

    ⚠️ 3.90 · WHICH SEQUENCE A VERSION FOLDER BELONGS TO. Two sequences can give one version
    ("Brand vid 9.0 [a.b][c.d] v3" and its "… v3 4x5" variant are both v9.0), and the panel
    refuses to export one into a folder the other already delivered into. Names cannot decide
    that on their own: a rename keeps the sequence, and two sequences can share a name. So
    the manifest records the ID the panel's own sequence check already compares on.

    Only when the dump describes THIS timeline — the rule overlay_dump() merges by: a dump
    of another sequence lends no identity. A missing, unreadable or foreign dump gives "",
    and the manifest then simply has no `id` (readers must tolerate its absence)."""
    try:
        data = json.loads(Path(dump_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(data, dict) or data.get("generator") != DumpTimeline.GENERATOR:
        return ""
    seq = data.get("sequence")
    if not isinstance(seq, dict):
        return ""
    if not same_sequence_name(seq.get("name"), tl.sequence_name):
        return ""
    return _dump_sequence_id(seq)


def same_sequence_name(dump_name, xml_name) -> bool:
    """Whether a panel dump's sequence name and the XML's are one timeline's name. True when
    either is empty (there is nothing to compare).

    ⚠️ STRIPPED AND CASE-FOLDED, the way `--sequence name:` matches (see _pick_sequence).
    txt() strips every name it reads out of the XML, and the dump carries Premiere's name
    exactly as typed — so a sequence called "Brand vid 9.0 v3 " (a trailing space, which
    Premiere keeps) never matched itself. MEASURED on the 3.90 build: overlay_dump() dropped
    the whole overlay ("not the same timeline, so nothing was merged") and panel_sequence_id()
    recorded no id, so the panel's folder rules fell back to names and let a duplicate of
    another id overwrite that sequence's delivery."""
    a = str(dump_name or "").strip().casefold()
    b = str(xml_name or "").strip().casefold()
    return not a or not b or a == b


def overlay_dump(tl, dump_path: Path) -> list[str]:
    """Overlay a panel dump onto an XML-parsed timeline. Returns notes to print.

    The two sources are not equal, and the merge reflects which is authoritative for
    what rather than preferring one wholesale:

      * The XML is the BASE. It is the path with the fixture behind it, and it is the
        only one that resolves nested sequences.
      * The panel supplies what an XML cannot express: the real keyframes of a speed
        ramp, and the media's CURRENT location.
      * Everything both of them carry — source range, speed, frame rate — is
        cross-checked, and a disagreement is reported rather than silently resolved.

    Only one thing here changes what gets cut: repairing a path the XML records at a
    stale location and the panel knows the truth of. That is a strict improvement — it
    only fires when the XML's path does not exist and the panel's does.
    """
    try:
        data = json.loads(dump_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [f"panel dump not found: {dump_path} — cut from the XML alone"]
    except json.JSONDecodeError as e:
        return [f"panel dump is not readable JSON ({e}) — cut from the XML alone"]
    if data.get("generator") != DumpTimeline.GENERATOR:
        return [f"{dump_path.name} was not written by the Raw-cutter panel "
                f"— cut from the XML alone"]

    notes: list[str] = []
    dseq = (data.get("sequence") or {}).get("name") or ""
    if not same_sequence_name(dseq, tl.sequence_name):
        notes.append(f"the panel read {dseq!r} but the XML is {tl.sequence_name!r} "
                     f"— not the same timeline, so nothing was merged")
        return notes

    # Bucket the dump by timeline start ticks — but as a LIST per tick, not one clip.
    # A real timeline stacks graphics, titles and adjustment layers over the footage,
    # so many clips share a start tick; keeping only the first silently matched a cut
    # against whatever happened to be on top. On real timeline that mismatched most
    # of the list, and since the merge can repoint a cut's media, a wrong match could
    # have pointed a cut at the wrong file.
    buckets = _TickBuckets()
    for c in data.get("clips") or []:
        if c.get("track_type") != "video":
            continue
        t = DumpTimeline._ticks(c.get("start"))
        if t is not None:
            buckets.setdefault(t, []).append(c)

    slack = PPRO_TICKS_PER_SECOND / max(tl.sequence_fps, 1)   # one frame
    repaired = ramps = rate_flags = range_flags = matched = ambiguous = tc_bases = 0

    for cut in tl.cuts:
        if cut.track_type != "video":
            continue
        # ⚠️ 3.93 AUDIT · A CUT FROM INSIDE A NEST HAS NO CLIP IN THE DUMP. host.jsx walks the
        # top-level track items only, so the nest is one clip there and its inner clips are
        # nowhere — anything found at an inner clip's instant is ANOTHER clip. The "only"
        # rule below then handed it over without comparing file names: MEASURED on 3.93, an
        # offline clip inside a nest and a B-roll clip on V2 starting on the same frame -> the
        # nested shot repointed at the B-roll's file, cut at the nested clip's own source
        # range, named after the wrong file and reported `ok`, and `3 of 3 video clip(s)
        # matched`. The dump can describe nothing about a nest's interior (not its path, not
        # its ramp, not its range), so such a cut is left exactly as the XML has it — an
        # offline one stays missing_source, which the panel offers to relink — and it counts
        # as unmatched, which is what the lead note's "(nests, …)" says.
        if cut.nested_from:
            continue
        want = int(round(cut.timeline_in_frames * PPRO_TICKS_PER_SECOND
                         / tl.sequence_fps))
        pc, how = match_dump_clip(buckets, want, slack, cut.source_path)
        if how == "ambiguous":
            ambiguous += 1
        if pc is None:
            # Expected for anything inside a nest — the panel saw the nest as one clip
            # — and for titles, graphics and adjustment layers, which carry no media.
            continue
        matched += 1
        pi = pc.get("project_item") or {}

        # -- path repair, the one thing that changes the cut ---------------------
        live = str(pi.get("media_path") or "")
        if (live and not cut.source_exists and os.path.isfile(live)
                and cut.media_kind != "unsupported"):
            cut.source_path = live
            cut.source_exists = True
            repaired += 1

        # -- the ramp curve, which only the panel has ---------------------------
        keys = []
        for comp in pc.get("components") or []:
            if not comp.get("is_time_remap"):
                continue
            for p in comp.get("params") or []:
                for k in p.get("keys") or []:
                    secs = (k.get("time") or {}).get("seconds")
                    val = k.get("value")
                    if isinstance(secs, (int, float)) and isinstance(val, (int, float)):
                        keys.append([round(float(secs), 6), round(float(val), 6)])
        if len(keys) > 1:
            keys.sort()
            cut.ramp_keys = keys
            cut.speed_varies = True
            vals = [v for _, v in keys]
            cut.speed_span = f"{min(vals) * 100:g}–{max(vals) * 100:g}%"
            ramps += 1

        # -- cross-checks: report, never silently resolve ------------------------
        interp = usable_fps((pc.get("interpretation") or {}).get("frame_rate"))
        if interp:
            cut.interpreted_fps = round(interp, 6)

        p_in = DumpTimeline._ticks(pc.get("in_point"))
        p_out = DumpTimeline._ticks(pc.get("out_point"))
        if p_in is not None and p_out is not None and p_out > p_in:
            # Scaled by speed, for the same reason DumpTimeline._build scales: these are
            # timeline units, not source units. Comparing them raw reported every
            # retimed clip as a disagreement, which is noise that hides real ones.
            p_speed = pc.get("speed")
            k = (abs(float(p_speed)) if isinstance(p_speed, (int, float)) and p_speed
                 else 1.0) or 1.0
            p_in_sec = (p_in / PPRO_TICKS_PER_SECOND) * k

            # Stills and Dynamic Link comps report inPoint as an ABSOLUTE media
            # timecode, which starts at 01:00:00:00 on this kind of media — so a clip
            # beginning at its own frame 0 comes back as 3600s. On a real timeline every
            # single reported disagreement was this, and a warning that is always wrong
            # is a warning you learn to skip. Subtract whole hours when the value is
            # within a frame of one; nothing genuinely sits an exact hour into a still.
            tc_base = 0.0
            if p_in_sec >= 3600.0 - 1.0:
                hours = round(p_in_sec / 3600.0)
                if hours >= 1 and abs(p_in_sec - hours * 3600.0) < 1.0:
                    tc_base = hours * 3600.0
                    p_in_sec -= tc_base

            d_in = p_in_sec - cut.source_in_seconds
            d_dur = (((p_out - p_in) / PPRO_TICKS_PER_SECOND) * k
                     - cut.source_duration_seconds)
            # A transition makes the XML's range legitimately longer — it includes the
            # material under the dissolve, which the panel's clip bounds do not — so
            # those clips are not reported as disagreeing.
            if not cut.edge_in_transition and (abs(d_in) > 0.004 or abs(d_dur) > 0.004):
                range_flags += 1
                if tc_base:
                    tc_bases += 1
                # ONE short line per clip. This used to repeat the whole explanation —
                # "Premiere and the XML disagree on the source range (…). The XML's value
                # was used — it is the verified path." — for every clip. On a real run of
                # three, that was 544 characters of which 465 were the same sentence three
                # times, carrying 79 characters of actual information. The explanation is
                # said once, in the lead note below.
                # The leading "· " marks this as a DETAIL of the lead note above rather than
                # a note in its own right. The panel indents these into a table under their
                # heading; on the command line it reads as the bullet it is.
                notes.append(f"· {cut.clip_name}: in {d_in:+.3f}s, "
                             f"length {d_dur:+.3f}s")

        p_speed = pc.get("speed")
        if isinstance(p_speed, (int, float)) and p_speed:
            p_pct = abs(float(p_speed)) * 100.0
            if abs(p_pct - cut.speed_percent) > 0.5 and not cut.speed_varies:
                notes.append(f"{cut.clip_name}: speed differs — Premiere {p_pct:.2f}%, "
                             f"XML {cut.speed_percent:.2f}%")

    # Counted against VIDEO cuts only. The overlay runs before --tracks filtering, so
    # comparing against every cut would report audio clips as "missing from the dump".
    video_cuts = sum(1 for c in tl.cuts if c.track_type == "video")
    unmatched = video_cuts - matched
    lead = [f"merged the panel's read of {dseq or 'the sequence'}: {matched} of "
            f"{video_cuts} video clip(s) matched"
            + (f", {unmatched} only in the XML (nests, titles, graphics)"
               if unmatched > 0 else "")]
    if ambiguous:
        # Nested content is no longer asked at all (see the loop above), so what is left is
        # a top-level cut whose instant holds several clips, none of them its file.
        why = "several clips share that instant and none carries this cut's filename"
        lead.append(f"{ambiguous} cut(s) kept the XML's values rather than guessing: {why}")
    if repaired:
        lead.append(f"repaired {repaired} media path(s) from Premiere's live location")
    if ramps:
        lead.append(f"read the real keyframes of {ramps} speed ramp(s) — "
                    f"in the manifest as ramp_keys")
    if range_flags:
        # The shared explanation, said ONCE. Everything after this in `notes` is one short
        # line per clip.
        lead.append(f"{range_flags} clip(s) disagree on the source range — the XML's "
                    f"value was used"
                    + (f"; a whole-hour timecode base was removed from {tc_bases} of them"
                       if tc_bases else ""))
    return lead + notes


# --------------------------------------------------------------------------
# ffprobe / ffmpeg
# --------------------------------------------------------------------------

# How long one ffprobe may take before it counts as unreadable. A default rather than a
# constant everywhere: every caller that has an args passes args.timeout, because "media
# that is slow to reach" is exactly what that flag exists for.
PROBE_READ_TIMEOUT = 60


def probe(path: str, timeout: float = PROBE_READ_TIMEOUT) -> dict:
    """ffprobe's JSON for this file — or `{"_probe_failed": <reason>}`, never a bare `{}`.

    ⚠️ "ffprobe SAID THERE IS NO AUDIO" AND "ffprobe DID NOT ANSWER" ARE DIFFERENT FACTS, and
    this function used to return `{}` for both, log nothing, and put nothing in the manifest.
    The empty result was then read downstream as a statement ABOUT THE MEDIA: run_cut's
    audio guard saw an empty audio_codec and refused the clip with "source has no audio
    stream — nothing to extract on an audio track", which is a confident sentence about a
    file it had never managed to open.

    MEASURED two ways. (1) Truncate a source .m4a to 55% of its bytes — an ordinary
    partly-downloaded cloud file: ffprobe exits 1 with `moov atom not found` and the run
    prints `Done: 20 written, 0 failed, … 3 silent source` with every voice-over row blaming
    the media. The audio is in the file; only the bytes are incomplete. (2) With a shim that
    fails -show_streams, a control run of `23 written` becomes `19 written … 4 silent
    source` — four real audio clips lost, nothing anywhere naming ffprobe. The manifest's
    media columns collapse in the same silence: same clip, control vs shim, codec 'h264'->'',
    width 640->None, pix_fmt 'yuv420p'->'', bitrate 1096193->None.

    The timeout is the caller's, not a hard-coded 60 s: the whole point of --timeout is media
    that is slow to reach, and a fixed limit here made that flag a half-measure. The `except`
    deliberately catches TimeoutExpired and OSError alike — a stall and a fault are both
    "could not read it", and both must be reported rather than shrugged off.
    """
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_streams", "-show_format", path],
            capture_output=True, text=True, timeout=timeout,
        )
        if r.returncode != 0:
            tail = [ln for ln in (r.stderr or "").strip().splitlines() if ln.strip()]
            return {"_probe_failed": (tail[-1][:200] if tail
                                      else f"ffprobe exited {r.returncode}")}
        return json.loads(r.stdout)
    except Exception as e:                                  # noqa: BLE001 — see docstring
        return {"_probe_failed": f"{type(e).__name__}: {e}"[:200]}


def media_end_seconds(data: dict, track_type: str) -> float:
    """Where the picture a cut of this track type reads ENDS, from one ffprobe answer, on the
    clock the cut's own seconds are on.

    A picture cut is measured against the first video stream that is not cover art. A
    stream that carries no duration of its own (Matroska keeps it in a tag) falls back to
    the container's, which is what every cut was measured against before; so does a figure
    larger than the container's, which the container would be wrong about.

    ⚠️ THE STREAM'S DURATION IS A LENGTH, NOT AN END. The picture ends at the video stream's
    start_time plus its duration, and the cut's seconds are counted from the CONTAINER's
    start_time — ffmpeg's input -ss adds format.start_time to the seek, and build_command
    seeks with nothing else (MEASURED, 23 Sep: with the container starting at 0.4787 and
    the picture at 0.5000, a cut at frame 100 delivered picture 99, which is where 3.3333 s
    after the CONTAINER's start falls). So the end on that clock is
    v.start_time + v.duration - format.start_time. Read as the bare duration, every file
    whose picture starts after its container came out a frame short: 20 of 294 real files
    on this machine start their picture 0.96-1.00 frame in (downloaded web video, all with
    the container at 0), a cut to the last frame of any of them was booked
    overhang_trimmed and lost that frame. Measured against the last packet's end on all 294:
    this form lands within 0.05 frame on 281, the bare duration on 261, and it is never the
    worse of the two. A stream with no start_time is taken to start with the container.

    ⚠️ AN AUDIO CUT KEEPS THE CONTAINER'S LENGTH, deliberately: the finding and every
    measurement behind this are about PICTURE, where -frames:v makes a missing frame fatal.
    Audio has no pin, an AAC stream's own duration carries its priming, and its out_time
    receipt in run_cut was tuned against the container — moving it is a separate question.
    """
    def _f(v) -> Optional[float]:
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    fmt = data.get("format") or {}
    whole = _f(fmt.get("duration")) or 0.0
    if track_type == "audio":
        return whole
    for s in data.get("streams", []):
        if s.get("codec_type") != "video":
            continue
        if (s.get("disposition") or {}).get("attached_pic"):
            continue
        own = _f(s.get("duration")) or 0.0
        if own <= 0:
            break
        f_start = _f(fmt.get("start_time")) or 0.0
        v_start = _f(s.get("start_time"))
        end = own + max(0.0, (f_start if v_start is None else v_start) - f_start)
        # 1e-5: each of the three figures is printed to six decimals, so a picture that ends
        # exactly where the container does can sum a few microseconds past it.
        if whole <= 0:
            return end
        if end <= whole + 1e-5:
            return min(end, whole)
        break
    return whole


def still_input(path: str) -> tuple[str, str]:
    """(the file ffmpeg and ffprobe should open for this still, why it cannot be, or "").

    The source itself for every still but HEIF_EXT; for those, a PNG made from it once by
    sips and kept in the temp folder, keyed by the source's path, size and modification
    time, so an edited photo is converted again and an unchanged one is not. Written under
    a unique temporary name and renamed, because parallel encodes can ask for it at once.
    """
    if Path(path).suffix.lower() not in HEIF_EXT:
        return path, ""
    try:
        st = os.stat(path)
    except OSError as e:
        return path, f"the photo could not be read ({e})"
    key = hashlib.sha1(f"{path}\0{st.st_size}\0{st.st_mtime_ns}".encode("utf-8")).hexdigest()
    d = Path(tempfile.gettempdir()) / "xmlcut-heif"
    out = d / f"{key[:20]}.png"
    try:
        if out.is_file() and out.stat().st_size > 0:
            return str(out), ""
    except OSError:
        pass
    sips = shutil.which("sips")
    if not sips:
        return path, ("an HEIC/HEIF/AVIF photo is converted for cutting by macOS's sips, "
                      "which is not on this machine — export the photo as PNG or JPEG")
    try:
        d.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=f".{key[:20]}.", suffix=".png", dir=str(d))
        os.close(fd)
    except OSError as e:
        return path, f"the photo could not be converted for cutting ({e})"
    try:
        r = subprocess.run([sips, "-s", "format", "png", path, "--out", tmp],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or os.path.getsize(tmp) <= 0:
            raise OSError((r.stderr or r.stdout or "no output").strip()[:200])
        os.replace(tmp, str(out))
    except (OSError, subprocess.SubprocessError) as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return path, (f"sips could not convert this HEIC/HEIF/AVIF photo for cutting ({e}) "
                      f"— export it as PNG or JPEG")
    return str(out), ""


def probe_source(path: str, timeout: float = PROBE_READ_TIMEOUT) -> dict:
    """probe() of the file a cut is actually read from. For a phone photo that is the PNG
    it is converted to (see HEIF_EXT): its own probe reports one 512x512 tile of a
    12-megapixel grid. Everything else is probed as itself. Used by both the pooled pre-warm
    and apply_probe, so the two cannot describe one file differently."""
    src, why = still_input(path)
    return {"_probe_failed": why} if why else probe(src, timeout)


def apply_probe(cut: Cut, cache: dict, timeout: float = PROBE_READ_TIMEOUT) -> None:
    if not cut.source_exists:
        return
    if cut.source_path not in cache:
        cache[cut.source_path] = probe_source(cut.source_path, timeout)
    data = cache[cut.source_path]
    # ⚠️ RECORDED ON THE CUT, and nothing else is read out of a failed probe. Leaving the
    # loop below to iterate an empty dict is how "ffprobe never answered" became "this file
    # has no audio" — the emptiness was indistinguishable from a real answer.
    if data.get("_probe_failed"):
        cut.probe_error = str(data["_probe_failed"])
        return
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and not cut.codec:
            cut.codec = s.get("codec_name", "")
            cut.width = s.get("width")
            cut.height = s.get("height")
            cut.pix_fmt = s.get("pix_fmt", "")
            rfr = s.get("r_frame_rate", "0/1")
            try:
                n, d = rfr.split("/")
                if float(d):
                    # UNROUNDED — this is the rate every frame index is computed on; the
                    # manifest rounds it for display, see RATE_FIELDS.
                    cut.source_fps = float(n) / float(d)
            except Exception:
                pass
            # Read beside it, never instead of it: r_frame_rate is the grid ffmpeg seeks on
            # and the only rate the cut arithmetic may use. avg_frame_rate is here purely so
            # the two can be compared — see Cut.source_avg_fps.
            try:
                n, d = s.get("avg_frame_rate", "0/1").split("/")
                if float(d):
                    cut.source_avg_fps = round(float(n) / float(d), 6)
            except Exception:
                pass
        elif s.get("codec_type") == "audio" and not cut.audio_codec:
            cut.audio_codec = s.get("codec_name", "")
            cut.audio_channels = s.get("channels")
            sr = s.get("sample_rate")
            cut.audio_sample_rate = int(sr) if sr else None
    br = data.get("format", {}).get("bit_rate")
    cut.bitrate = int(br) if br else None

    # ⚠️ A VARIABLE-RATE FILE IS CUT ON 3.88'S NUMBERS, ALL OF THEM — the rate rounded to six
    # decimals as 3.88 stored it, the overhang measured against the container. Three rounds of
    # changes to this path each traded one defect for another, and every one was checked on a
    # 1/600 fixture, where a seek always lands on a tick: measured on frame-ID VFR media on
    # 1/30000, 1/60000 and 1/90000 clocks (23 Sep), 4-6 of 20 forward clips per mode opened on
    # the frame BEFORE the in-point, all reported ok, where 3.88 delivered them slot-exact.
    # So the fixes for constant-rate media — the unrounded rate (see RATE_FIELDS), the
    # picture's own end (media_end_seconds) and the frame-index resample (frame_map_filters)
    # — stop at this test. The rate is rounded FIRST and the test asked on the rounded value,
    # so a file is variable-rate here exactly when 3.88's own warning called it that.
    _exact_fps = cut.source_fps
    cut.source_fps = round(_exact_fps, 6)
    _base_numbers = variable_rate_source(cut)
    if not _base_numbers:
        cut.source_fps = _exact_fps

    # ⚠️ DOES THIS CUT REACH PAST THE END OF THE FILE? Asked here because this is the first
    # point that knows both numbers: what the timeline asked for, and how long the media
    # really is. Trimmed BEFORE consumed_frames below, so the pinned count, the manifest and
    # the filename all describe the same range — the alternative is failing at the encoder
    # with a count nobody can trace back to a cause.
    #
    # TWO FRAMES, and the number is derived rather than picked. Premiere rounds a file's
    # length UP to a whole frame (measured: 1913 declared against 1912 real), which is one;
    # the cut boundary can then land a frame either side of that, which is the second. More
    # than two frames is not arithmetic, it is material the file does not contain, and that
    # still fails — a voice-over declared 6.56 s that holds 4.36 s must not be quietly
    # delivered 2.2 s short. Measured across 242 real delivered clips: 3 overhang at all, at
    # 1.00, 1.61 and 5.94 frames, and this line passes the first two and refuses the third.
    #
    # ⚠️ MEASURED AGAINST THE STREAM THE CUT READS, NOT THE CONTAINER. format.duration is the
    # LONGEST stream, and on a file whose sound outlasts its picture that is the sound: a
    # picture cut one or two frames past the last video frame read as no overhang at all,
    # the pin asked for frames that do not exist, and run_cut refused the clip as "the
    # source is shorter than the cut, or unreadable" — where the same cut on a file whose
    # audio ends with its video was pulled back and delivered. Not rare: 38 of 294 real
    # files on this machine have a container 0.5-5 frames longer than their video stream's
    # duration, and on 37 of the 38 the last packet ends exactly at the video stream's
    # start_time plus its duration (measured, 23 Sep) — 20 of them because the picture
    # starts a frame after the container, which is why the END has to be worked out and not
    # read off the duration. Audio cuts are left on the container — see media_end_seconds().
    if cut.media_kind != "still" and not cut.render_path:
        if _base_numbers:
            try:
                _media = float((data.get("format") or {}).get("duration") or 0.0)
            except (TypeError, ValueError):
                _media = 0.0
        else:
            _media = media_end_seconds(data, cut.track_type)
        if _media > 0:
            _over = (cut.source_in_seconds + cut.source_duration_seconds) - _media
            if _over > 1e-6:
                cut.overhang_seconds = _over
                _fps = cut.source_fps or 0.0
                _cap = (OVERHANG_TRIM_FRAMES / _fps) if _fps > 0 else 0.0
                # The epsilon is not decoration: an overhang of exactly two frames
                # arrives as 0.06666666666666687 against a cap of 0.06666666666666667 and
                # was refused for a rounding error a micro-second wide.
                if _fps > 0 and _over <= _cap + 1e-6:
                    cut.source_duration_seconds = max(0.0, _media - cut.source_in_seconds)
                    cut.overhang_trimmed = True

    # ffprobe is more authoritative about the native rate than the XML's <file><rate>,
    # so recompute the consumed-frame count against it. This keeps the manifest column
    # identical to the -frames:v value build_command pins, by construction.
    if cut.media_kind != "still" and cut.source_fps > 0:
        cut.source_consumed_frames = consumed_frames(
            cut.source_in_seconds, cut.source_duration_seconds, cut.source_fps)


def pix_fmt_for(cut: Cut) -> str:
    """The pixel format to encode in, preserving the source's wherever x264 can.

    "Lossless" has to actually mean it. Forcing yuv420p on a 10-bit 4:2:2 ProRes source
    discards half the chroma and two bits per sample *before* the encoder sees them, and
    no crf value gets that back. So keep the source format when it is supported, and
    record what was used either way.

    Stills are the exception: they arrive as rgb24/rgba, which x264 cannot take, and they
    are usually graphics or a logo where 4:2:0 chroma subsampling is the most visible loss
    there is. 4:4:4 costs almost nothing across a handful of frames.
    """
    # Everything lands in 4:2:0. Preserving a 10-bit 4:2:2 source used to be the right
    # call under lossless, but any format above 8-bit 4:2:0 pushes x264 into a High 10 or
    # 4:4:4 profile, which is the exact thing that made these files unplayable. Playable
    # everywhere beats a chroma fidelity nothing downstream was reading.
    return "yuv420p"


def codec_flags(cut: Cut, args) -> list[str]:
    """The encoder settings, in ONE place.

    build_command has three exits — stills, audio, video — and each used to repeat the
    codec flags. Adding crf/bitrate to two of three would have been a silent inconsistency
    that only showed up on a timeline containing stills.
    """
    crf = crf_of(args)
    preset = getattr(args, "x264_preset", None) or X264_PRESET
    rate = parse_bitrate(getattr(args, "bitrate", None) or "")
    vcodec = vcodec_of(args)
    out = ["-c:v", vcodec]
    if rate:
        # Target-rate mode: the point of it is a predictable file size, so cap the peak
        # and give it a buffer rather than letting the average drift.
        out += ["-b:v", str(rate), "-maxrate", str(int(rate * 1.5)),
                "-bufsize", str(int(rate * 2))]
    else:
        out += ["-crf", crf_text(crf)]
    out += ["-preset", preset]
    # ⚠️ "high" is an H.264 PROFILE NAME. x265 has its own set (main, main10, …) and errors
    # out on this one, so the pin that keeps x264 off High 4:4:4 Predictive — the profile no
    # Mac will play — applies only to x264. x265's 8-bit main profile is chosen by pix_fmt
    # anyway, which is set just below.
    if vcodec == "libx264":
        out += ["-profile:v", X264_PROFILE]
    out += ["-pix_fmt", cut.pix_fmt_out]
    # HEVC in an mp4 needs the hvc1 tag to play in QuickTime and Premiere; without it the
    # file is technically valid and macOS refuses to preview it.
    if vcodec == "libx265":
        out += ["-tag:v", "hvc1"]
    return out


# How close two frame rates must be to count as THE SAME rate. Deliberately far below
# the gap that matters: 30000/1001 is 29.97003, which sits 0.03 from 30 — thirty times
# this epsilon — so 29.97 media asked for 30 fps is still correctly called a resample.
# Only float noise and a rate typed to a few decimals fall inside it.
FPS_EPS = 1e-3


def retime_to_timeline(cut: Cut, args, seq_fps: float) -> bool:
    """Does this cut have to be resampled to the SEQUENCE rate to play as it did on screen?

    --speed timeline means "the clip as it played", which a speed ramp obviously needs —
    but so does a 100%-speed 24 fps clip in a 30 fps timeline: without it the clip is
    pinned to its 48 native frames instead of the 60 sequence frames it occupies, and
    comes out 20% short.

    ONE definition because build_command takes a different branch on it and
    forced_rate_resamples() has to know which branch that will be. Two copies of this
    expression would let the command and the frame_exact flag disagree about the same cut.
    """
    rate_mismatch = cut.source_fps > 0 and abs(cut.source_fps - seq_fps) > 0.01
    return (getattr(args, "speed", "native") == "timeline"
            and (is_retimed(cut.speed_percent) or rate_mismatch))


def forced_rate_resamples(cut: Cut, args, seq_fps: float) -> bool:
    """Would --fps actually drop or duplicate frames in THIS cut?

    ⚠️ ASKING THE QUESTION PER CUT IS THE WHOLE POINT. --fps used to emit `-r` on every
    video cut and mark every cut frame_exact=false, without ever comparing a rate to
    anything. Measured on real media: a 30 fps source cut at --fps 30 is not merely a
    no-op, it is HARMFUL — the half-frame seek below lands the wanted frame at PTS +0.5
    frame and ffmpeg's CFR converter resolves that ambiguity by DUPLICATING it, so a
    29-frame cut came back as [57, 57, 58 … 84]: the head twice and the tail missing.
    Without -r the same cut is a clean 57..85.

    False (nothing is resampled) when:

    * no --fps was given, or the rate ffmpeg will read already equals it;
    * the cut takes a branch of build_command that emits no `-r` at all. MEASURED by a
      verifier at --fps 60: a still, an audio-track cut and the retime/reverse branch all
      return before the flag is reached, yet a naive predicate marked all three
      not-frame-exact — on the real fixture, 4 audio cuts and a still wrongly flagged.

    WHICH rate is the input depends on the mode. In source mode ffmpeg opens the camera
    file, so a 24 fps source in a 30 fps timeline IS resampled at --fps 30. In render mode
    it opens Premiere's render, which comes back at the SEQUENCE rate whatever the source
    was. A rate we do not know counts as AFFECTED: never promise exactness that cannot be
    verified.
    """
    out_fps = float(getattr(args, "fps", None) or 0.0)
    if out_fps <= 0:
        return False
    # Render mode first, exactly as build_command branches: the render replaces the
    # source, and render_planned is the scan-time form of the same thing.
    # ⚠️ ASK WHAT RATE THE FILE COMES OUT AT, NOT WHICH BRANCH BUILT IT. An earlier
    # version exempted the still, audio and retime branches outright, on the belief that
    # none of them emits a rate flag. Two of the three do — the retime branch emits
    # `-r seq_fps` below and the still branch pins `-framerate seq_fps` — so --fps was
    # silently dropped on those cuts AND they were recorded frame_exact=true. Measured on
    # tests/PROMO_MASTER_v7.xml at --fps 60: 13 of 25 cuts came out at 30 fps while the
    # manifest claimed 60 and called every one of them exact. Both branches now honour
    # --fps, and this predicate compares against the rate each one will actually use.
    if cut.track_type == "audio":
        return False                       # no picture, so no frame to drop or duplicate
    if cut.render_path or (cut.render_planned and cut.track_type == "video"):
        in_fps = cut.render_fps or seq_fps or 0.0
    elif cut.media_kind == "still":
        return False                       # every frame identical, and emitted AT out_fps
    elif retime_to_timeline(cut, args, seq_fps):
        # A retime is already resampled against the sequence by construction, and that is
        # the rate it lands on. Asking for a different one resamples it a SECOND time;
        # asking for the sequence's own rate adds nothing. A REVERSE is different — it
        # keeps the source rate — so it falls through to the source comparison below.
        in_fps = seq_fps or 0.0
    else:
        in_fps = cut.source_fps or 0.0
    if in_fps <= 0:
        return True
    return abs(in_fps - out_fps) > FPS_EPS


def records_a_rate(cut: Cut) -> bool:
    """Will a file be written whose frame rate frame_exact can describe?

    ⚠️ SEPARATE FROM forced_rate_resamples ON PURPOSE. That predicate answers what
    build_command must DO with a cut it is about to encode, and both callers have to get
    the same answer or the command and the manifest describe different files. This one is
    about the RECORD, and it only ever loosens it: run_cut refuses an unsupported clip and
    a missing source before it builds any command, so a rate flag on either is a statement
    about a file nobody receives.

    MEASURED on two encodable 30 fps cuts beside one offline clip and one Dynamic Link
    comp, both DECLARED 24 fps, at --fps 30: the console said "RESAMPLED to 30 fps: 2 of 4
    cut(s) drop or duplicate frames", the encode line said "2 of 4 cut(s) not frame exact",
    and settings.frame_exact went false — for a folder whose every written file is exact,
    which is also what makes tests/verify.py refuse to grade it. Both rows are already
    named as missing and as a comp in the same console block.
    """
    if cut.render_path or (cut.render_planned and cut.track_type == "video"):
        return True                        # the render supplies the pixels
    return bool(cut.source_exists) and cut.media_kind != "unsupported"


def audio_target_seconds(cut: Cut, args, seq_fps: float) -> Optional[float]:
    """How long this cut's AUDIO delivery has to be, or None when the question doesn't apply.

    ONE definition for the same reason retime_to_timeline() is one: build_command pins the
    retimed chain to this length and run_cut checks the delivery against it, and two copies
    of the expression would let the pin and the check disagree about the same cut.

    Only the audio branch, because it is the only branch of build_command that pins no
    -frames:v — everywhere else the frame count is the receipt, and a second one measured in
    seconds could only contradict it.

    Two answers, matching the two shapes that branch builds. A retimed cut is resampled to
    play into its timeline slot, so the slot is its length; everything else delivers exactly
    the source range it consumed.
    """
    if cut.track_type != "audio":
        return None
    if retime_to_timeline(cut, args, seq_fps):
        return (cut.duration_seconds or 0.0) or None
    return (cut.source_duration_seconds or 0.0) or None


# ─────────────────────────────────────────────────── where a video seek has to aim
#
# ⚠️ WHICH FRAME `-ss T -i FILE` RETURNS IS A PROPERTY OF THE INSTALLED ffmpeg, NOT OF THE
# FILE, AND IT HAS CHANGED UNDER THIS TOOL. The comment history in build_command records
# three formulas each "measured correct" and later measured wrong — half a frame early, a
# quarter frame late, exactly on the frame — and two of those records contradict each other
# on the same kind of file. They were all true on the ffmpeg of their day. On ffmpeg 9.0.1
# (Homebrew, 23 Sep 2026) the rule is "the first frame whose timestamp is at or after T",
# measured by pixel against a full decode; an older build behaved differently. Editors run
# whatever `brew install ffmpeg` gave them, so no constant can be right on every Mac.
#
# And the one point every rule agrees on — T exactly equal to the frame's timestamp — is
# only that frame's timestamp on a file whose frames sit EXACTLY on the k/fps grid. iPhone
# footage does not: 59.94 fps in a 1/600 timebase is 10- and 11-tick frames, running up to
# 0.16 of a frame early and 0.12 late of the grid (surveyed across eight of the team's
# 224 MOVs). Aiming exactly at k/fps on ffmpeg 9 therefore skipped every early frame:
# MEASURED, 22 of 160 seeks returned frame k+1, all on iPhone files, 19-56% per file, and
# on the team's own R11 edit 4 of 9 delivered clips started a frame late and ended a frame
# past the out-point, every one marked ok and frame_exact.
#
# So the aim is MEASURED, once per ffmpeg build, on a clip whose frames carry their own
# index as brightness: seek to eight sub-frame offsets around a known frame, keep the
# offsets that return it, and aim at the middle of that range. On ffmpeg 9 that is half a
# frame early; on a build that returns the frame displaying at T it would be half a frame
# late; either way the aim has the widest margin available against grid drift. Checked on
# the same 160 seeks: 0 wrong. The result is cached per `ffmpeg -version` line in the temp
# folder, and ANY failure to measure falls back to 0 — today's behaviour — uncached, so the
# next run tries again rather than living with a guess.
_SEEK_BIAS: Optional[float] = None
_SEEK_BIAS_LOCK = threading.Lock()
_SEEK_CAL_OFFSETS = (-0.875, -0.625, -0.375, -0.125, 0.125, 0.375, 0.625, 0.875)


def _measure_seek_bias() -> float:
    try:
        ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                             timeout=20).stdout.splitlines()[0].strip()
    except Exception:                                       # noqa: BLE001
        return 0.0
    cache = Path(tempfile.gettempdir()) / "xmlcut-seek-bias.json"
    try:
        known = json.loads(cache.read_text())
        if isinstance(known, dict) and ver in known:
            b = float(known[ver])
            if -1.0 < b < 1.0:
                return b
    except Exception:                                       # noqa: BLE001
        known = {}
    if not isinstance(known, dict):
        known = {}
    fps, k = 10, 10
    try:
        with tempfile.TemporaryDirectory(prefix="xmlcut-seekcal-") as d:
            src = str(Path(d) / "cal.mov")
            # Frame N is brightness 12N+6: twenty frames, far enough apart that encoding and
            # the colour-range round trip cannot move one index into its neighbour's.
            r = subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
                 "-i", f"nullsrc=s=16x16:r={fps}:d=2",
                 "-vf", "format=gray,geq=lum='12*N+6'", "-c:v", "libx264", "-qp", "0",
                 "-pix_fmt", "yuv420p", src],
                capture_output=True, timeout=60)
            if r.returncode != 0:
                return 0.0
            hits = []
            for o in _SEEK_CAL_OFFSETS:
                g = subprocess.run(
                    ["ffmpeg", "-v", "error", "-ss", f"{(k + o) / fps:.6f}", "-i", src,
                     "-frames:v", "1", "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"],
                    capture_output=True, timeout=30).stdout
                if g and round((g[0] - 6) / 12) == k:
                    hits.append(o)
    except Exception:                                       # noqa: BLE001
        return 0.0
    # The offsets that return the frame have to be ONE unbroken run, or the measurement is
    # not describing a seek rule and nothing is inferred from it.
    idx = [_SEEK_CAL_OFFSETS.index(o) for o in hits]
    if not hits or idx != list(range(idx[0], idx[0] + len(idx))):
        return 0.0
    bias = (min(hits) + max(hits)) / 2
    known[ver] = bias
    try:
        cache.write_text(json.dumps(known))
    except OSError:
        pass
    return bias


def seek_bias() -> float:
    """Frames from a frame's nominal time to aim an input seek so this ffmpeg returns it."""
    global _SEEK_BIAS
    if _SEEK_BIAS is None:
        with _SEEK_BIAS_LOCK:
            if _SEEK_BIAS is None:
                _SEEK_BIAS = _measure_seek_bias()
    return _SEEK_BIAS


# ─────────────────────────────────────────────────── which source frame fills each output slot
#
# ⚠️ EVERY RESAMPLE IN build_command GOES THROUGH HERE — EXCEPT A CUT OF MEDIA WHOSE HEADER
# SAYS IT IS VARIABLE-RATE, forward or reversed, which keeps 3.88's filters, see
# keeps_base_resample() below — AND IT MAPS BY FRAME INDEX, NOT BY TIME. The four resample sites used to end in `fps=X:round=up` on the frames' own
# timestamps, which puts in output slot j the source frame displaying at j/X. That is right
# whenever the pin and the two rates agree — it is what the 6 Sep fix bought (output 0 is the
# in-point on a 300% retime, not a later frame) — and exactly wrong when the output rate sits
# a hair ABOVE the input: the two rates the panel offers, 30 and 60, on 29.97/59.94 footage.
# Input frame 1 then starts 1/1000 of a frame after slot 1 does, so slot 1 still shows frame
# 0, every frame after it lands one slot late, and the -frames:v pin cuts the shot's last
# frame off. MEASURED by frame ID on the real engine, 23 Sep: --fps 30 on 29.97 came back
# [100, 100, 101 … 138] for 100..139 on 4 of 4 clips, --fps 60 on 59.94 the same on 3 of 3,
# and --fps 30 on 59.94 opened [200, 201, 203 …] and stayed one source frame out of step to
# the end (… 595, 597 where 596, 598 is every other frame from the in-point). On the team's
# own iPhone edit at --fps 60, 8 of 8 clips lost their last frame, all reported OK.
# round=near is no answer — it throws the in-point away above two source frames per output
# frame, which is the bug round=up was brought in to fix.
#
# So the mapping is stated outright, on the two numbers each caller has already worked out:
# the cut's n source frames and the m output slots its -frames:v pins.
#
#   m <= n (the same count, or fewer slots than frames): slot j shows frame floor(j*n/m).
#       This IS what round=up delivered whenever the rates agree with the pin — 60->30 is
#       every other frame from the in-point, 300% is 0, 3, 6 … — and with m == n (every
#       29.97->30 clip under 500 frames) it is the identity: no duplicate at all.
#   m > n (more slots than frames, so some frame has to repeat): frame i takes over at slot
#       round(i*m/n), halves up. An integer slow-down still holds every frame for the same
#       number of slots (25% is four each, exactly as before), but a clip one frame SHORT of
#       its slots — 29.97->30 over 500 frames, 59.94->60 over 8.3 s — repeats a frame in the
#       MIDDLE, where time-based rounding put the repeat on slot 1: the cut itself.
#
#   `centred=False` keeps the first rule for m > n as well. The --speed timeline retime at
#   the sequence's own rate passes it: there floor(j*n/m) is Premiere's own frame sampling
#   (a 24 fps clip in a 30 fps timeline shows 0, 0, 1, 2, 3, 4, 4 …), and matching what the
#   timeline showed is that mode's whole promise.
#
# Either way output 0 is the in-point, no slot shows a frame outside [0, n), and the last
# slot shows the range's own tail when m >= n. A frame past n (the generous -t reads one
# more) is parked past the pin, where it can never be shown.
#
# How: setpts stamps frame N at the slot where it takes over, plus a fraction of 1/(4n) of a
# slot that keeps it strictly inside the slot it belongs to, and fps=round=down then holds
# each frame until the next one takes over. It is stamped in a NANOSECOND timebase because a
# camera timebase (1/600 on iPhone) cannot hold 1/(4n) of a slot; the margin stays wider
# than the nanosecond truncation up to ~4 million frames at 60 fps. The fps filter is handed
# the SAME rational the stamps were computed on, so its conversion into slots is exact
# integer arithmetic. setpts also stamps the END of the stream by the same expression at
# N = frames seen, so a range that ends on the file's last frame still fills its last slot.
def frame_map_filters(n_in: int, m_out: int, out_fps: float,
                      centred: bool = True) -> list[str]:
    """The video filters that lay n_in consecutive frames onto m_out slots at out_fps."""
    n, m = max(1, int(n_in)), max(1, int(m_out))
    q = Fraction(f"{float(out_fps):.6f}")
    # ffmpeg reads a decimal rate through av_d2q with both terms bounded by 1001000, so a
    # rate typed to more digits than that is written as the rational it can actually hold.
    if q.numerator > 1001000 or q.denominator > 1001000:
        q = q.limit_denominator(max(1, int(1001000 / max(1.0, float(out_fps)))))
    exact = q == Fraction(f"{float(out_fps):.6f}")
    rate = f"{float(out_fps):.6f}" if exact else f"{q.numerator}/{q.denominator}"
    # Slot position of frame N, in quarters of 1/n of a slot: (4mN + K) / 4n.
    #   ceil(N*m/n)          ==  floor((4mN + 4n - 2) / 4n)
    #   floor(N*m/n + 1/2)   ==  floor((4mN + 2n + 1) / 4n)
    k = (2 * n + 1) if (centred and m > n) else (4 * n - 2)
    ns_num = q.denominator * 10 ** 9          # one slot is q.den/q.num s = ns_num/q.num ns
    ns_den = 4 * n * q.numerator
    return ["settb=1/1000000000",
            f"setpts=(4*{m}*N+{k})*{ns_num}/{ns_den}",
            f"fps={rate}:round=down"]


# How far r_frame_rate and avg_frame_rate may disagree before a file counts as variable-rate.
# 0.2% is the gap the REINTERPRETED check in main() already treats as a real disagreement
# rather than float noise; the variable-rate warning there, apply_probe() and
# keeps_base_resample() below all ask through variable_rate_source(), so the file that is
# warned about is exactly the file that is cut on 3.88's numbers — and it is 3.88's own test,
# moved here unchanged.
VFR_RATE_GAP = 0.002


def variable_rate_source(cut: Cut) -> bool:
    """Does this cut's own header say its frames are not on the nominal grid?"""
    return (cut.source_fps > 0 and cut.source_avg_fps > 0
            and abs(cut.source_fps - cut.source_avg_fps) / cut.source_fps > VFR_RATE_GAP)


def keeps_base_resample(cut: Cut, n_frames: int) -> bool:
    """Should a resample of this cut, forward or reversed, keep 3.88's own filters?

    ⚠️ YES FOR EVERY VARIABLE-RATE FILE, AND THAT IS A DECISION, NOT AN ANSWER. On such a file
    frame_map_filters() counts frames that are not there: n is the range's length times the
    NOMINAL rate, a phone that drops frames holds fewer, and the index map walks through the
    out-point (measured: 5-10 frames past a 2-4 s cut at --fps 30, all `ok`). Three rounds of
    replacements for it — time sampling anchored on the in-point, a one-second seek lead, a
    forward-then-reversed sampling grid — each traded one defect for another, and each was
    checked only on a 1/600 fixture, where a seek always lands on a tick. MEASURED on frame-ID
    VFR media at 29.97/59.94 on 1/30000, 1/60000 and 1/90000 clocks, 23 Sep: 4-6 of 20
    forward clips per mode opened on the frame BEFORE the in-point (seek_bias lands the
    printed -ss on a half tick, ffmpeg rounds it to the stream's time base by up to half a
    tick, and the anchor's 1e-4-frame epsilon is smaller than that), and 7-12 of 20 reversed
    clips opened with a frame from past the out-point — every one reported ok, where 3.88 had
    delivered the forward ones slot-exact. So a variable-rate cut is cut exactly as 3.88 cut
    it, in every mode: `setpts=PTS/k` for a retime, `select` + `reverse` for a reverse, and
    `fps=X:round=up` on the frames' own timestamps, with 3.88's six-decimal rate and its
    container-length overhang (see apply_probe). Its own imperfections on such files are
    pre-existing and not traded for new ones here — MEASURED on the 120 variable-rate clips
    in tests/check_delivery.py: 62 refused as "wrote 26 frame(s) where 30 were asked" (the pin
    counts nominal frames the range does not hold), and all 16 delivered reversed clips open
    on a frame from past the out-point. That suite pins every command to 3.88's formula and
    grades the pixels on 1/30000, 1/60000, 1/90000 and 1/600 variable-rate fixtures.

    With no frame count at all (no source rate) there is nothing to map by index either,
    and 3.88's time-rounded chain is all there is. Constant-rate media with a count keeps the
    index map, where it is exact.
    """
    return n_frames <= 0 or variable_rate_source(cut)


def build_command(cut: Cut, out_path: Path, args, seq_fps: float) -> list[str]:
    # ⚠️ -progress IS THE RECEIPT, and it is on every branch because run_cut had no way to
    # tell a finished encode from a truncated one. `-frames:v N` is a LIMIT, not a promise:
    # when the input runs out first ffmpeg writes fewer frames, exits 0 and says NOTHING.
    # Measured on a 480-frame source: asking for 6 frames one frame before the end exits 0
    # with stderr exactly 0 bytes and writes 5; asking for 24 frames entirely past the end
    # exits 0 with stderr exactly 0 bytes and writes a 261-byte mp4 with no video stream at
    # all. Both were delivered as `OK`, status ok, frame_exact true. `-progress pipe:1`
    # reports frame=5 and frame=0 for those two, costs no extra process, and does not
    # depend on the container carrying an nb_frames tag. Nothing else in the tool reads
    # ffmpeg's stdout, so the channel is free — see the frame check in run_cut.
    # -nostats keeps the interactive status line off it.
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats",
           "-progress", "pipe:1", "-y"]

    # RENDER MODE, and it comes first because it replaces everything below rather than
    # adding to it. The input IS this cut's timeline range: Premiere rendered from the
    # in-point to the out-point, so there is nothing to seek to and nothing to trim.
    #
    # Every trick the source path needs is not just unnecessary here but WRONG. The
    # speed ramp is already in the pixels; re-applying setpts would apply it twice. The
    # reverse is already reversed. The half-frame -ss nudge has no frame to nudge onto.
    # A still is no longer a still — it is however many frames it occupied on screen.
    #
    # -frames:v pins the count on EVERY render command, so a render that came back a
    # frame long is trimmed here rather than quietly lengthening the clip, and one that
    # came back a frame short fails the count check in run_cut rather than shipping.
    if cut.render_path:
        cmd += ["-i", cut.render_path]
        # ⚠️ THE SURPLUS FRAME IS DROPPED HERE, AND ONLY ON EVIDENCE. -frames:v below keeps
        # the FIRST N frames, which is right when a too-long render overshot at the tail and
        # wrong at every frame when it overshot at the head. resolve_render_overshoot() has
        # already compared this render's first two frames against the previous render's last
        # one; render_head_trim is non-zero only when that comparison was unambiguous, and an
        # unclear one refuses the cut in run_cut rather than reaching this line.
        #
        # `trim=start_frame=`, NOT -ss. trim counts FRAMES; -ss counts seconds and would put
        # back the fraction-of-a-frame rounding this mechanism exists to remove. It goes
        # FIRST in the chain so any fps filter resamples the corrected frames, and setpts
        # rebases the timestamps so the output does not start at frame one's PTS.
        _trim = ([f"trim=start_frame={cut.render_head_trim}", "setpts=PTS-STARTPTS"]
                 if cut.render_head_trim > 0 else [])
        # ⚠️ `fps=X`, NOT `-r X` — the same measured mis-mapping the source branch documents
        # below. MEASURED here too: a 30-frame (1 s) render under --render-dir --fps 24 came
        # out 26 frames / 1.083 s, 8% long, and reads 24 frames / 1.000 s with the filter.
        _res = forced_rate_resamples(cut, args, seq_fps)
        _vf = list(_trim)
        # ⚠️ CONVERTED, NOT DROPPED. This used to read `if not _vf:`, so a --fps that
        # REALLY resamples left the render branch with no -frames:v at all — the one
        # branch in the file with nothing bounding its output length. pinned_frame_count()
        # then returned None and run_cut's got-vs-want check stood down. MEASURED on a
        # 29.97 sequence at --fps 30: a render one frame SHORT of its range delivered 59
        # frames into a 60-frame slot as `status=ok`, and one frame long delivered 61 —
        # both inside RENDER_FRAME_SLACK (2), so the render check above passes them, and
        # the same two renders WITHOUT --fps already failed and trimmed respectively.
        # Under --render-audio the -t below happened to bound it; with the default silent
        # render nothing did.
        #
        # Restated in OUTPUT frames exactly as the source branch does at the -frames:v
        # below, because -frames:v counts frames AFTER the fps filter has resampled. The
        # input rate is the RENDER's, not the camera's: Premiere writes the render at the
        # sequence rate whatever the source was.
        _in_fps = cut.render_fps or seq_fps or 0.0
        _pin = (max(1, int(round(cut.duration_frames * float(args.fps) / _in_fps)))
                if _res and _in_fps > 0 else max(1, cut.duration_frames))
        if _res:
            # Laid on by frame index — see frame_map_filters() for why `fps=X` alone doubled
            # the head of every render at --fps 30 on a 29.97 sequence. n is the frames this
            # render really HOLDS for the range once a repaired head is gone, capped at the
            # cut: a surplus tail frame is parked past the pin, and a render short by one
            # frame inside RENDER_FRAME_SLACK still fills every slot, which is the documented
            # policy the round=up filter used to meet by an accident of its rounding (see the
            # 59/60 render checks in tests/check_delivery.py).
            _have = cut.duration_frames
            if cut.render_frames:
                _have = min(_have, cut.render_frames - max(0, cut.render_head_trim))
            _vf += frame_map_filters(max(1, _have), _pin, float(args.fps))
        cmd += ["-frames:v", str(_pin)]
        sf = scale_filter(args)
        if sf:
            _vf.append(sf)
        if _vf:
            cmd += ["-filter:v", ",".join(_vf)]
        # ⚠️ THE RENDER CARRIES PREMIERE'S MIX — a Match Source preset renders AAC alongside
        # the picture (measured: every _renders/*.mp4 has an aac stereo stream) — and this
        # branch threw it away with -an on every clip, so a Timeline Render clip was always
        # silent whatever the timeline played. With --render-audio the mix is kept, re-encoded
        # and cut off with the pinned video (-shortest) rather than running on to the render's
        # own end. WHICH tracks are in that mix is decided upstream: the panel mutes the
        # unticked audio tracks before Premiere renders. Default unchanged — silent, as every
        # export so far — so nobody's clips gain sound without asking.
        if getattr(args, "render_audio", False):
            # -t at the cut's own length, NOT -shortest: a render's AAC can end a hair before
            # its last picture frame, and -shortest would then clip the VIDEO and fail the
            # frame-count check. -t bounds the sound; -frames:v still pins the picture.
            _rfps = cut.render_fps or seq_fps or 30.0
            _dur = max(1, cut.duration_frames) / _rfps
            # ⚠️ AND THE SOUND LOSES THE SAME FRAME THE PICTURE DID. _trim above is a VIDEO
            # filter, so on a head-repaired clip the picture started at render frame 1 while
            # the sound still started at render frame 0: the audio led the picture by one
            # frame, the surplus frame's sound shipped, and the cut's own last frame's sound
            # was dropped — reproduced end to end by review, on exactly the clips the run
            # reports as REPAIRED. atrim, not an input -ss: -ss moves both streams and would
            # shift the already-trimmed picture a second time. asetpts rebases the audio to
            # zero, which is what keeps -t correct.
            if cut.render_head_trim > 0:
                cmd += ["-filter:a",
                        f"atrim=start={cut.render_head_trim / _rfps:.6f},"
                        f"asetpts=PTS-STARTPTS"]
            cmd += [*codec_flags(cut, args), "-movflags", "+faststart",
                    "-c:a", "aac", "-b:a", "192k", "-t", f"{_dur:.6f}", str(out_path)]
        else:
            cmd += [*codec_flags(cut, args), "-movflags", "+faststart", "-an",
                    str(out_path)]
        return cmd

    if cut.media_kind == "still":
        # A still has no timeline to seek into — loop it for the on-screen duration.
        # The even-rounding scale that has always been here IS scale_filter at 100%, so
        # the two are one expression rather than a special case bolted beside a general
        # one. A still with an odd dimension still cannot be encoded, scaled or not.
        _out = float(getattr(args, "fps", None) or 0.0) or seq_fps
        cmd += ["-loop", "1", "-framerate", f"{_out:.6f}",
                # A phone photo is looped as the PNG it was converted to (see HEIF_EXT).
                "-i", still_input(cut.source_path)[0],
                "-t", f"{cut.source_duration_seconds:.6f}",
                *codec_flags(cut, args),
                "-movflags", "+faststart",
                "-vf", scale_filter(args) or "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-an", str(out_path)]
        return cmd

    # ffmpeg's -ss takes the first frame whose PTS is >= the seek time, so aim HALF
    # A FRAME EARLY to land squarely on the wanted frame. Without this, a source at
    # a different rate to the timeline (24 fps media in a 30 fps sequence) computes
    # a time a hair past the frame boundary and ffmpeg starts one frame late.
    # --speed timeline means "the clip as it played on screen", which requires
    # resampling to the sequence rate. A speed ramp is the obvious case, but a
    # 100%-speed 24 fps clip in a 30 fps timeline needs it just as much: without
    # it the clip is pinned to its 48 native frames instead of the 60 sequence
    # frames it occupies, and comes out 20% short.
    retime = retime_to_timeline(cut, args, seq_fps)

    ss, t = cut.source_in_seconds, cut.source_duration_seconds
    fps = cut.source_fps or 0
    n_frames = 0
    # ⚠️ VIDEO ONLY, AND THAT IS THE WHOLE FIX FOR AUDIO. Everything in this block — the
    # frame-grid snap and the half-frame lead — exists because a PICTURE stream quantises:
    # ffmpeg takes the first frame whose PTS is >= the seek time, so aiming half a frame
    # early lands ON the wanted frame. Audio does not quantise. -ss on an audio stream is
    # honoured to the sample, so the same lead is not compensation, it is a straight offset,
    # and the audio branch below then used the mutated `ss` while passing the UNMUTATED
    # source_duration_seconds as -t — so the head gained material from before the in-point
    # and the tail lost exactly as much.
    #
    # MEASURED with a click train (one click every 0.250000 s), each delivered file against
    # a control encode with an exact -ss so the AAC priming cancels:
    #   file rate 25 in a 30 fps sequence, in-point 12.666667 s -> emitted -ss 12.620000,
    #     first click 0.130021 s vs control 0.083354 s   = +46.667 ms = 1.4 video frames
    #   file rate 25, in-point on the 25 grid (5.0 s)   -> -ss 4.980000  = +20.000 ms
    #   file rate 30 == sequence rate, on the grid      -> -ss 3.316667  = +16.667 ms
    # The best case was half a video frame early; it was never zero. Every one of those rows
    # published frame_exact true and its exact intended source_in_seconds.
    #
    # `fps` here is cut.source_fps, which for an audio-only file is the XML's <file><rate>
    # (apply_probe only overwrites source_fps from a VIDEO stream), so there was no
    # configuration in which the offset was absent. n_frames is not read by the audio branch
    # at all, so nothing else in it changes.
    if fps > 0 and cut.track_type != "audio":
        # Tolerance is expressed in FRAMES, not seconds — a hair over a frame
        # boundary must floor down, but float noise and any upstream rounding must
        # not. 1e-4 of a frame is far above the noise and far below half a frame,
        # so a genuinely mid-frame in-point still floors correctly.
        start_f = int(ss * fps + 1e-4)
        # THE SAME NUMBER THE MANIFEST REPORTS. This used to be round(t * fps) — the
        # very rule consumed_frames() was written to replace, left behind here when that
        # function was introduced. The two agree for any range covering a whole number
        # of frames, which is every clip the fixture had, so the divergence went unseen:
        # on a range of 55.26 frames the manifest said 56 and ffmpeg was told 55, and the
        # file did not match its own label. One definition, one call.
        n_frames = max(1, cut.source_consumed_frames
                       or consumed_frames(ss, t, fps))
        # ⚠️ AIM A QUARTER FRAME *INTO* THE WANTED FRAME, NOT HALF A FRAME BEFORE IT.
        #
        # The rule this line used to state — "-ss takes the first frame whose PTS is >=
        # the seek time, so aim half a frame early" — is FALSE, and it cost a year of
        # one-frame-early heads. With -ss before -i and an accurate seek, ffmpeg hands
        # back the frame that is DISPLAYING at that instant. Half a frame early is inside
        # the PREVIOUS frame's display interval, so that is the frame you get.
        #
        # MEASURED on real media (30 fps, exact PTS, frame 320 at 10.666667 and frame 321
        # at 10.700000), asking for frame 321:
        #     (f - 0.5)/fps  -> -ss 10.683333 -> frame 320   WRONG, one early
        #     f/fps          -> -ss 10.700000 -> frame 321   right, but sits ON the
        #                                                    boundary, so float noise can
        #                                                    tip it either way
        #     (f + 0.25)/fps -> -ss 10.708333 -> frame 321   right, with margin
        #     (f + 0.5)/fps  -> -ss 10.716667 -> frame 322   WRONG, one late
        #
        # A quarter frame in is 0.25 from the boundary behind and 0.75 from the one ahead,
        # which is the widest margin available on both sides. It also keeps the original
        # intent — a rate-mismatched source (24 fps media in a 30 fps sequence) computing a
        # time a hair past the boundary must not start one LATE — because a hair past the
        # boundary plus a quarter frame is still inside the same frame.
        #
        # This is what the reviewer reported three times as "lech 1 frame dau tien sang
        # canh dang truoc": the first frame belonged to the shot before. Reproduced on his
        # own timeline — 3 of 13 measurable clips came out one frame early, every one of
        # them a cut whose in-point landed exactly on a frame boundary.
        # ⚠️ THE FRAME'S OWN PTS. NO OFFSET. Any offset at all is a guess about how
        # ffmpeg resolves a seek that lands between two frames, and that guess is not
        # stable across files. MEASURED on two real sources, both with exact 1/30
        # timestamps starting at 0, asking for a known frame:
        #     seek                     2.1 enhanced.mp4      S17.mp4
        #     (f - 0.5)/fps            (was correct here)    ONE EARLY
        #     (f + 0.25)/fps           ONE LATE              correct
        #     f/fps                    correct               correct
        # The half-frame-early form shipped for months and is what the reviewer reported
        # three times as "lech 1 frame dau tien sang canh dang truoc" — the first frame
        # belonged to the previous shot. A quarter-frame-late form fixed those and broke
        # four other cuts the other way. Seeking to the frame's exact PTS is the only
        # expression that was right on every case, which is what you would expect: it is
        # the only one that does not ask ffmpeg to break a tie.
        # 3.89 · AIMED BY MEASUREMENT, NOT BY THE GRID — see seek_bias() above. The comment
        # block above this line records the history of trying to answer this with a
        # constant; every entry in it was right on the ffmpeg it was measured on.
        ss = max(0.0, (start_f + seek_bias()) / fps)
        t = (n_frames + 1) / fps     # generous bound; the exact count is pinned below

    if cut.track_type == "audio":
        # An audio-track clipitem must produce audio, not a video file with a soundtrack.
        # The old path fell through to the video branch and pinned -frames:v, which on an
        # audio-only source produced nothing at all.
        chain = ["areverse"] if cut.reversed else []
        if retime:
            rem = (cut.speed_percent / 100.0) or 1.0
            while rem > 2.0:                # atempo is valid only in [0.5, 2.0]
                chain.append("atempo=2.0"); rem /= 2.0
            while rem < 0.5:
                chain.append("atempo=0.5"); rem /= 0.5
            chain.append(f"atempo={rem:.6f}")
            # ⚠️ atempo's OUTPUT LENGTH IS NOT input/tempo, and nothing here used to bound
            # it. Its WSOLA window swallows the tail at EVERY rate, measured on one click
            # train: k=1.0 loses 1024 samples (21.3 ms), 0.75 loses 1664, 0.5 loses 2944
            # (61.3 ms), 2.0 loses 576. So a 50% clip in a 2.0 s slot came back 1.938667 s
            # while its PICTURE was pinned to exactly 60 frames and the manifest asserted
            # 2.0 — the two drifted apart by 3% of the clip with nothing said. A no-op
            # atempo=1.0 does it too, and retime_to_timeline() emits one for any audio
            # clipitem whose file rate merely differs from the sequence's.
            #
            # ⚠️ THE PAD IS BOUNDED, and that is the whole design. `apad` alone would fill
            # ANY shortfall with silence — including a source that ran out mid-range, which
            # is exactly what the out_time receipt in run_cut exists to refuse. A quarter of
            # a second covers the widest residue measured (61 ms) with room for a chained
            # atempo, and leaves anything larger still short enough to fail the check.
            _tgt = audio_target_seconds(cut, args, seq_fps)
            if _tgt:
                chain.append(f"apad=pad_dur={AUDIO_RETIME_PAD:.6f}")
                chain.append(f"atrim=end={_tgt:.6f}")
        # Seek early, trim the lead off in the graph — see AUDIO_SEEK_LEAD. atrim goes FIRST
        # so areverse/atempo act on exactly the wanted range, and asetpts re-zeroes the
        # timestamps so the container starts at 0 rather than at the lead.
        lead = min(AUDIO_SEEK_LEAD, ss)
        # ⚠️ NO -ss AT ALL WHEN IT WOULD BE ZERO. Even `-ss 0` is a seek, and a seek on an
        # audio-only AAC file drops the priming: measured, the click AT the in-point vanished
        # and the next one arrived 21.3 ms early. Decoding from the start with no seek keeps
        # it (0 samples off, measured). atrim=start=0 is then a no-op and stays for symmetry.
        if ss - lead > 1e-9:
            cmd += ["-ss", f"{ss - lead:.6f}"]
        cmd += ["-t", f"{cut.source_duration_seconds + lead:.6f}", "-i", cut.source_path, "-vn"]
        chain = [f"atrim=start={lead:.6f}:end={lead + cut.source_duration_seconds:.6f}",
                 "asetpts=N/SR/TB"] + chain
        cmd += ["-filter:a", ",".join(chain)]
        cmd += ["-c:a", "aac", "-b:a", "192k", str(out_path)]
        return cmd

    if retime or cut.reversed:
        # Trim on the INPUT side here: ffmpeg's default CFR sync re-times frames back
        # to the input rate on output, silently undoing setpts. Reading the exact
        # source range first, then resampling to the sequence rate with -r, is what
        # actually makes the clip play at the edited speed.
        k = (cut.speed_percent / 100.0) or 1.0
        # ⚠️ TIME RE-ZEROED ON THE FIRST FRAME ACTUALLY DECODED, before anything reads it.
        # An input seek re-zeroes time at the SEEK POINT, and since 3.89 that point is aimed
        # a measured fraction of a frame away from the frame (seek_bias) — so without this
        # the first frame arrived stamped +0.5 of a frame, and every filter that rounds on
        # time picked differently: MEASURED, a 200% clip consumed 201 source frames for 200,
        # a 60 fps source at --fps 30 started one frame late, a reversed 200% clip one early.
        # Re-zeroed here, frame k is at 0 exactly as it was when the seek sat on its
        # timestamp, and everything downstream sees what it saw before the aim moved.
        vf: list[str] = ["setpts=PTS-STARTPTS"]

        # ⚠️ THE RESAMPLE IS A FILTER, NOT THE OUTPUT OPTION -r. This is worked out here,
        # ahead of the scale filter, because it has to sit in the chain after select/reverse
        # and BEFORE any scale — see the note below the branch.
        #
        # ⚠️ AND ON CONSTANT-RATE MEDIA IT IS frame_map_filters(), which replaces the
        # `setpts=PTS/{k}` + `fps=…:round=up` pair this branch used to end in (a variable-rate
        # file keeps that pair — see keeps_base_resample()). The speed needs no filter of its
        # own: n source frames laid onto m output slots IS the retime. The old pair rounded
        # on TIME, so its answer drifted from the pin whenever the two rates were a hair
        # apart — a reversed 29.97 clip at --fps 30, and a 100% 29.97 clip retimed into a 30
        # fps timeline, each came back with a frame twice and the range's last one missing,
        # exactly as the source branch did (both graded by pixel in tests/check_estimate.py).
        _pin = 0
        if retime:
            # --fps applies here too. The frame count is a TIMELINE count at seq_fps, so it
            # has to be restated in output frames or the clip is truncated the same way the
            # source branch was.
            _out = float(getattr(args, "fps", None) or 0.0) or seq_fps
            _pin = (max(1, int(round(cut.duration_frames * _out / seq_fps)))
                    if seq_fps > 0 else max(1, cut.duration_frames))
            _resample = True
        else:
            # A reverse with no retime resampled nothing, so --fps was silently dropped here
            # as well. `select` counts INPUT frames and runs before the resample, so only the
            # output pin has to be restated.
            _out = float(getattr(args, "fps", None) or 0.0)
            _src = cut.source_fps or 0.0
            _resample = _out > 0 and _src > 0 and abs(_out - _src) > FPS_EPS
            _pin = max(1, int(round(n_frames * _out / _src))) if _resample else max(1, n_frames)

        if cut.reversed:
            # `reverse` buffers everything that reaches it and emits it backwards, so
            # the FIRST output frame is the LAST input frame. The generous -t bound
            # above deliberately reads one frame more than wanted, which here would
            # land that spare frame at the very front of the clip — the one frame a
            # reversed cut can least afford to get wrong. So pin the exact set with
            # `select` before reversing, not with -frames:v after it.
            vf.append(f"select='lt(n\\,{max(1, n_frames)})'")
            vf.append("reverse")

        if _resample and not keeps_base_resample(cut, n_frames):
            # centred only under a --fps that really resamples again: at the sequence's own
            # rate floor(j*n/m) is Premiere's frame sampling, which is what this mode
            # promises to reproduce — see frame_map_filters(). A reverse with no retime is
            # always a real resample (_resample above), so it is always centred.
            vf += frame_map_filters(max(1, n_frames), _pin, _out,
                                    centred=(not retime) or abs(_out - seq_fps) > FPS_EPS)
        else:
            # ⚠️ 3.88'S CHAIN, UNCHANGED, for a variable-rate file (or one with no rate to
            # count frames by) — see keeps_base_resample() for the three rounds of
            # replacements that each traded one defect for another there.
            if retime:
                vf.append(f"setpts=PTS/{k:.6f}")
            elif cut.reversed:
                # reverse hands on the buffered timestamps; restamp for a clean CFR mux
                vf.append("setpts=N/FRAME_RATE/TB")
            if _resample:
                vf.append(f"fps={_out:.6f}:round=up")
        # LAST in the chain, after select/reverse/setpts/fps. Scaling first would resize
        # every frame `reverse` buffers, including the ones `select` is about to throw away.
        sf = scale_filter(args)
        if sf:
            vf.append(sf)

        cmd += ["-ss", f"{ss:.6f}", "-t", f"{t:.6f}", "-i", cut.source_path]
        if vf:
            cmd += ["-filter:v", ",".join(vf)]
        cmd += ["-frames:v", str(_pin)]

        cmd += [*codec_flags(cut, args),
                "-movflags", "+faststart", "-an"]
        cmd += [str(out_path)]
        return cmd

    cmd += ["-ss", f"{ss:.6f}", "-i", cut.source_path]
    cmd += ["-t", f"{t:.6f}"]
    # ⚠️ An explicit output rate RESAMPLES: ffmpeg drops or duplicates frames to hit it.
    # The file then no longer holds the frames the timeline used, which is the property
    # every check in tests/verify.py rests on. Recorded per clip as frame_exact=false.
    #
    # Asked per cut, not off the flag: --fps 30 on 30 fps media changes nothing about the
    # pixels and, emitted anyway, actively corrupts the head — see forced_rate_resamples.
    resample = forced_rate_resamples(cut, args, seq_fps)

    # Frame count, not duration, is what must be exact — -t alone loses the last
    # frame to timestamp rounding on roughly half of real-world clips.
    #
    # ⚠️ -frames:v COUNTS OUTPUT FRAMES, AFTER -r HAS RESAMPLED. Pinning the SOURCE count
    # under a resample truncates the clip, and silently: measured on 24 fps media at
    # --fps 30, `-frames:v 48 -r 30` wrote 48 output frames covering 1.600s and source
    # frames 24..61, losing the last 10 frames of a 2.000s range. Converted to output
    # frames (60) the same command covers 2.000s and source 24..71 — the identical range
    # the cut holds with no --fps at all.
    if n_frames:
        want = n_frames
        if resample:
            want = max(1, int(round(n_frames * float(args.fps) / fps)))
        cmd += ["-frames:v", str(want)]

    # ⚠️ THE RESAMPLE IS A FILTER, NOT THE OUTPUT OPTION -r, AND THAT IS NOT A STYLE CHOICE.
    # MEASURED on byte-identical inputs with a burned-in frame index, `-r X` resolves the
    # input-to-output frame mapping differently from `fps=X`: it emits several CONSECUTIVE
    # source frames at the head and then runs a permanent lag, never reaching the last frames
    # of the requested range.
    #
    #   30 fps source, frames 100..119 at 25% (80 output frames):
    #       -r 30  -> last delivered frame is 120 — a frame from OUTSIDE the cut
    #       fps=30 -> last is 119, clean 4-frame groups, the exact range
    #   30 fps source, frames 120..179 REVERSED at 200% (30 output frames):
    #       -r 30  -> [179,178,177,176,175,173,171,...,125] — five consecutive frames at the
    #                 head, and the tail stops 4 source frames early
    #       fps=30 -> [179,177,175,...,121] — exact, no head stutter
    #   30 fps source, 20 frames REVERSED at 50% (40 output frames):
    #       -r 30  -> 39 frames written for a pinned 40. Nothing at all filled the last
    #                 output slot, so the file is one frame shorter than the timeline hole
    #                 it has to fill; before the frame check in run_cut this shipped as `ok`
    #                 with frame_exact true, and it now fails the whole clip instead.
    #       fps=30 -> 40 frames, [219,219,218,218,...,200,200]
    #   60 fps source at --fps 30: -r -> last=235 (4 source frames lost); fps= -> last=238.
    #
    # The obvious alternative explanations were ruled out by measurement rather than argued
    # away: making setpts STARTPTS-relative, and removing the half-frame seek lead entirely,
    # each change the output not at all.
    #
    # It goes in the SAME -filter:v as the scale, ahead of it — resampling after a scale
    # would resize frames that are about to be dropped.
    # ⚠️ RE-ZEROED HERE TOO, for the same reason as the branch above — and it is needed even
    # with no other filter: without it the delivered file itself would START half a frame
    # in, which a player shows as a gap and a timing check reads as a short clip.
    _vf = ["setpts=PTS-STARTPTS"]
    if resample and keeps_base_resample(cut, n_frames):
        # ⚠️ 3.88's filter, unchanged, for a variable-rate file or one with no rate to count
        # by — see keeps_base_resample().
        _vf.append(f"fps={float(args.fps):.6f}:round=up")
    elif resample:
        # Laid on by frame index — see frame_map_filters() for why `fps=X`, rounded either
        # way, doubles the head of a 29.97 clip at --fps 30.
        _vf += frame_map_filters(n_frames, want, float(args.fps))
    # Added only when it does something. At 100% this branch had no -filter:v at all and
    # still should not: an identity scale is a full decode-filter-encode pass that changes
    # nothing, and it would silently become the norm for every export.
    sf = scale_filter(args)
    if sf:
        _vf.append(sf)
    if _vf:
        cmd += ["-filter:v", ",".join(_vf)]

    cmd += [
        # crf/bitrate/preset come from codec_flags; the PROFILE stays pinned inside it, so
        # lossless mode can never quietly reintroduce High 4:4:4 Predictive — a profile no
        # Mac decoder will open.
        *codec_flags(cut, args),
        "-movflags", "+faststart",       # so it starts playing without reading the tail
        # NO AUDIO, always — see the note on the constants. An AAC track made every
        # container declare a duration one frame longer than its own video stream.
        "-an",
    ]
    cmd += [str(out_path)]
    return cmd


def write_track_audio(tl, args) -> list:
    """ONE audio file per chosen TRACK, each as long as the sequence.

    "e chỉ cần để lựa chọn tích vào từng track A1,2,3,... để render toàn bộ track đấy ra
    thành file audio riêng thôi" — 8 Sep. The reason he gives is the one that matters: "vốn
    là ngta chỉ cần file VO từ đầu tới cuối thôi". A voice-over spread across ninety clipitems
    is one performance, and what anyone downstream wants is the performance, not ninety
    fragments they have to reassemble.

    This is NOT the per-cut audio (one file per clip, paired with its video) and NOT the
    single mixed timeline mp3 (every chosen track summed into one). It is the middle thing
    that was missing: A2 alone, whole, at its timeline positions, with the gaps as silence.

    Same mixer as both of those, so the gain staging, the mono up-mix correction and the
    keyframed-fader warning are the one implementation they have always been.
    """
    items = getattr(tl, "audio_items", None) or []
    if not items:
        return []
    # ⚠️ NO RE-FILTERING HERE. tl.audio_items has ALREADY been narrowed by --audio-tracks in
    # main() — re-applying the filter would be a second implementation of the same rule, and
    # the one in main() is where the "you named a track this timeline does not have" warning
    # lives.
    #
    # ⚠️ AND premiere_track, NOT track_index. The XML's lane ordinal is a per-CHANNEL index:
    # nine lanes for four tracks on the real export, so grouping by track_index would write
    # A2 and A3 for the two halves of one stereo pair. premiere_track is the number the
    # editor and the panel menu both speak in, which is what has to appear in the filename.
    tracks = sorted({int(a.premiere_track) for a in items})
    out = []
    for t in tracks:
        mine = [a for a in items if int(a.premiere_track) == t]
        res = write_timeline_audio(tl, args, items=mine, out_name=f"_track_A{t}.mp3")
        if res:
            res["track"] = t
            out.append(res)
    return out


def write_timeline_audio(tl, args, items=None, out_name="_timeline_audio.mp3") -> dict:
    """ONE mp3 for the whole timeline: every selected audio item at its timeline position, over
    silence, for the sequence's full length.

    "also make it as one single mp3 file" — 18 Aug, alongside the per-cut files rather than
    instead of them: a continuous track is what you hand a transcriber or line up against the
    edit, and the per-cut files are what pair with the clips. Nothing is lost by having both.

    Built by the SAME mixer as a cut's own audio, on a stand-in Cut that spans frame 0 to the end
    of the sequence — so the overlap arithmetic, the silence base and the level handling are one
    implementation with one set of tests, not two that can drift.
    """
    # ⚠️ THE ITEM LIST AND THE FILENAME ARE ARGUMENTS NOW, and nothing else moved. The whole
    # point of this function's docstring is that the per-cut mix and the whole-timeline mix
    # are ONE implementation with one set of tests; writing a second mixer for per-track
    # files would have been the third. Called with no arguments it is exactly what it was.
    items = list(items) if items is not None else (getattr(tl, "audio_items", None) or [])
    frames = int(getattr(tl, "sequence_duration_frames", 0) or 0)
    fps = tl.sequence_fps or 25.0
    if not items or frames <= 0:
        return {}
    whole = Cut(track_type="video", timeline_in_frames=0, timeline_out_frames=frames)
    parts, note = vo_contributions(whole, items, fps)
    # ⚠️ AN ITEM PARKED PAST THE END OF THE SEQUENCE WAS DROPPED IN SILENCE. MEASURED on a
    # real export: a music .wav sat at frames 2515-2641 on a timeline whose
    # duration is 1426, so a two-item track reported `parts: 1` with an empty note and no
    # warning anywhere. Here — and only here — a non-overlap really does mean "outside the
    # sequence", because `whole` spans all of it; in a per-cut mix it is ordinary.
    outside = [a for a in items
               if a.timeline_in_frames >= frames
               or (a.timeline_out_frames or a.timeline_in_frames) <= 0]
    if outside:
        names = sorted({Path(a.source_path).name or a.clip_name for a in outside})
        note = ((note + "; ") if note else "") + (
            f"{len(outside)} audio item(s) sit outside the sequence's own length "
            f"({frames} frames) and are not in the mix: " + ", ".join(names[:4])
            + (", …" if len(names) > 4 else ""))
    # ⚠️ AUDIO TRANSITIONS THE MIX COULD NOT PLACE, said rather than dropped. audio_fades_for
    # ties a transition to the clip edge it defines; one that matches no edge has no fade in
    # this file, and "what the timeline sounds like" may not quietly lose it.
    _tracks = {int(a.premiere_track) for a in items}
    _unplaced = sorted(u for u in (getattr(tl, "audio_transitions_unplaced", None) or ())
                       if u[0] in _tracks)
    if _unplaced:
        note = ((note + "; ") if note else "") + (
            f"{len(_unplaced)} audio transition(s) could not be tied to a clip edge and are "
            f"NOT in the mix as fades")
    total = frames / fps
    out_path = args.out / out_name

    # ⚠️ EVERY SOURCE PROBED BEFORE IT GOES NEAR THE MIX — and one that ffmpeg cannot read is
    # left out BY NAME instead of taking every other part down with it. The mix is ONE
    # ffmpeg command with one -i per part, so a single undecodable input failed all of them:
    # MEASURED on the audit fixture (music A1, voice-over A2, one SFX on A3), a .wav of
    # random bytes lost the whole _timeline_audio.mp3 and _track_A3.mp3 to "Invalid data
    # found", and a relinked .mov with no audio stream left BOTH as 0-byte files ("Error
    # binding filtergraph") — rc 0, warnings [], "0 failed". The audio_items capture only
    # filters by extension, so it cannot see either. The same probe gives the channel layout
    # that the mono up-mix and the sourcetrack selection below need, so it costs nothing new:
    # one ffprobe per DISTINCT source, not per part — a 90-part voice-over is three files.
    cache = getattr(tl, "_audio_probe_cache", None)
    if cache is None:
        cache = {}
        try:
            tl._audio_probe_cache = cache
        except AttributeError:
            pass
    bad: dict = {}
    kept = []
    for d in parts:
        if d["path"] not in cache:
            cache[d["path"]] = probe_audio_streams(d["path"])
        streams, why = cache[d["path"]]
        if why:
            bad[d["path"]] = why
            continue
        d["streams"] = streams
        kept.append(d)
    if bad:
        names = sorted(f"{Path(p).name} ({w})" for p, w in bad.items())
        note = ((note + "; ") if note else "") + (
            f"{len(bad)} source(s) left out because ffmpeg cannot read their audio: "
            + ", ".join(names[:4]) + (", …" if len(names) > 4 else ""))
        # Kept on the timeline for main() to warn about ONCE, however many of the files
        # this run writes (every track file and the mix) had to leave the same source out.
        try:
            tl.audio_unreadable = {**(getattr(tl, "audio_unreadable", None) or {}), **bad}
        except AttributeError:
            pass
    parts = kept
    if not parts:
        # outside_sequence rides on this branch too: a track whose ONLY item sits past the
        # end of the sequence lands here, and that is precisely the case that was silent.
        return {"note": note or "no audio items to mix",
                "outside_sequence": len(outside)}

    # ⚠️ THE CHANNEL LAYOUT OF EACH PART, because the mono up-mix penalty cannot be fixed
    # blind. A mono part fed to a stereo mix loses 3 dB to libswresample's power-preserving
    # rematrix (measured -3.30 dB on a fixture voice) and vo_mix_command corrects it with an
    # explicit pan — but that same pan on a STEREO part would throw the right channel away,
    # so the correction is applied only where the probe actually said 1. None (the probe
    # timed out) means leave it alone.
    #
    # ⚠️ AND WHICH CHANNEL A MONO CLIP PLAYS. <sourcetrack> was never read and the mix took
    # [i:a] whole: MEASURED on a camera file with the lav on audio stream 1 and the boom on
    # stream 2, the boom clip's _track_A2.mp3 held the LAV (3 kHz band -90 dB) and the mix
    # had no boom at all; with one stereo stream (lav left, boom right) each track file held
    # both mics. A clip on a one-lane track is mono (see Cut.source_track) and plays channel
    # N of its file, counted across streams in order — Premiere's own numbering — so N picks
    # a stream and a channel inside it. Out of range, it is left whole and said so.
    _range = 0
    for d in parts:
        streams = d.pop("streams")
        d["stream"], d["channel"] = None, None
        d["channels"] = streams[0] if streams else None
        if d.get("mono_clip") and streams:
            n = int(d.get("source_track") or 1) - 1
            for si, nch in enumerate(streams):
                if n < nch:
                    d["stream"], d["channel"], d["channels"] = si, n, 1
                    break
                n -= nch
            else:
                _range += 1
    if _range:
        note = ((note + "; ") if note else "") + (
            f"{_range} mono part(s) name a source channel their file does not have — the "
            f"first stream was mixed whole")

    # ⚠️ GAIN STAGING, MEASURED RATHER THAN GUESSED. amix(normalize=0) sums its inputs, so a
    # timeline of commercially mastered material runs off the top: MEASURED here, two
    # sources normalised to -0.2 dBFS (commercial master level) sum to +5.80 dBFS, and the
    # delivered mp3 read 0.00 dBFS — clipped — because there was nothing between the sum and
    # the encoder. With the make-up it reads -1.30 dBFS. A first pass to the
    # null muxer costs a decode and no encode, and tells us the real peak; the second pass
    # applies exactly enough attenuation to sit at TIMELINE_AUDIO_CEILING_DBFS and records
    # the number. Attenuation ONLY — a quiet mix is left where the editor put it, because
    # normalising a mix upward would misrepresent the edit just as badly in the other
    # direction. When the peak cannot be read the mix is written unchanged, as before.
    peak_db = mix_peak_dbfs(vo_mix_command(whole, parts, total, Path(os.devnull)),
                            getattr(args, "timeout", 3600))
    gain_db = 0.0
    if peak_db is not None and peak_db > TIMELINE_AUDIO_CEILING_DBFS:
        gain_db = round(TIMELINE_AUDIO_CEILING_DBFS - peak_db, 3)
    # ⚠️ WRITTEN UNDER A PARTIAL NAME AND MOVED ONTO THE DELIVERY NAME ONLY WHEN IT IS WHOLE —
    # the clips' own rule, the clips' own name (partial_name). ffmpeg -y truncates its output
    # before it knows whether the graph will run, and it wrote straight onto the delivery
    # name, so a failed mix left what it had there: MEASURED, a relinked .mov with no audio
    # stream left a 0-byte _timeline_audio.mp3 ("Error binding filtergraph", rc 0), and a
    # volume filled to ~1 MB free left a 262144-byte mp3 playing 10.9 s of a 35.9 s timeline
    # under the delivered name. A failure now leaves nothing of this run behind.
    #
    # ⚠️ AND IT RUNS THROUGH _run_tracked, so a Cancel kills this ffmpeg and removes its
    # partial like any clip's (see _stop_on_signal). Two themes fixed this same call in the
    # 3.89 work — one for the note it carries, one for Cancel — and this is both.
    part_path = out_path.with_name(partial_name(out_path.name))
    part_path.unlink(missing_ok=True)       # a killed run's leftover; ffmpeg -y would reuse it
    fail = None
    try:
        try:
            r = _run_tracked(vo_mix_command(whole, parts, total, part_path, gain_db),
                             args.timeout, part_path)
            if r.returncode != 0 or not part_path.exists() or part_path.stat().st_size == 0:
                tail = (r.stderr or "").strip().splitlines()
                fail = tail[-1][:120] if tail else "no output"
            else:
                try:
                    os.replace(str(part_path), str(out_path))
                except OSError as e:
                    fail = f"mixed but could not be put in place: {e}"
        except subprocess.TimeoutExpired as e:
            # Not str(e): that is the whole ffmpeg command, every absolute path in it, and it
            # went onto a `!!` line and into the manifest once per track (~2.5 KB measured).
            fail = f"timed out after {e.timeout:g} s (--timeout)"
        except OSError as e:
            fail = str(e)[:160]
    finally:
        part_path.unlink(missing_ok=True)
        _release_part(part_path)
    if fail is not None:
        return {"note": ((note + "; ") if note else "") + "timeline audio failed: " + fail}
    _fades = sum(len(d.get("fades") or []) for d in parts)
    # ⚠️ SAID OUT LOUD WHEN THE MIX IS NOT THE EDIT'S OWN BALANCE. A keyframed fader is
    # reduced to its first key (read_audio_level), and a mix that had to be pulled down to
    # stay under full scale is no longer at the level Premiere's master would show. Both are
    # defensible; neither may be silent, because the whole claim of this file is "what the
    # timeline sounds like".
    _kf = sum(1 for d in parts if d.get("gain_varies"))
    if _kf:
        note = ((note + "; ") if note else "") + (
            f"{_kf} part(s) have a KEYFRAMED Audio Level — the first keyframe was used "
            f"for the whole part, so those fades are not in the mix")
    if gain_db:
        note = ((note + "; ") if note else "") + (
            f"the mix summed to {peak_db:+.2f} dBFS, so {gain_db:+.2f} dB was applied to "
            f"the whole file to keep it under full scale — relative levels are unchanged")
    # ⚠️ WHAT ACTUALLY WENT IN, BY NAME. Before this, `grep -c <a music file's name> manifest.json`
    # returned 0: no artefact anywhere named the material in the mix, which is exactly why
    # "A2 only" shipped a full copy of the background music for a whole release with every
    # numeric field reading green. A name is the one thing a wrong number cannot fake.
    counts: dict = {}
    for d in parts:
        n = Path(d["path"]).name or "(unnamed)"
        counts[n] = counts.get(n, 0) + 1
    sources = [{"name": n, "parts": counts[n]} for n in sorted(counts)]
    return {"file": out_path.name, "bytes": out_path.stat().st_size,
            "seconds": round(total, 6), "parts": len(parts), "note": note,
            "sources": sources,
            # ⚠️ THE FILE'S LEVEL, AS A STATED NUMBER. Before this the manifest reported the
            # mix as complete and said nothing about what happened to it on the way — a
            # reader could not tell an un-levelled sum from the edit's own balance, nor a
            # clipped file from a clean one. levels_applied is the answer to "is this the
            # mix the editor made"; peak_dbfs and mix_gain_db are the answer to "and at what
            # level". peak_dbfs is the sum BEFORE the make-up, so it is also the evidence
            # that the make-up was needed.
            "levels_applied": True,
            "levels_keyframed": _kf,
            "mono_parts_upmixed": sum(1 for d in parts if d.get("channels") == 1),
            # How many transition fades the file carries, and how many it could not place.
            "fades_applied": _fades,
            "transitions_unplaced": len(_unplaced),
            "sources_unreadable": len(bad),
            "peak_dbfs": (None if peak_db is None else round(peak_db, 3)),
            "mix_gain_db": gain_db,
            "ceiling_dbfs": TIMELINE_AUDIO_CEILING_DBFS,
            "outside_sequence": len(outside)}


def report_audio_deliveries(tl, args) -> None:
    """Put what went wrong with the audio files where the panel and the manifest show it.

    ⚠️ A NOTE IN settings IS NOT A WARNING. Before this, a mix that lost a source, a track
    file that was never written and a previous run's mp3 still sitting at the delivery name
    were all at most a note inside settings.timeline_audio / track_audio — rc 0, warnings
    [], "Done: … 0 failed". The panel promotes '!!' lines and shows tl.warnings; it does not
    read those notes for a written file. So each of these three becomes one warning here,
    printed with '!!', once per run however many files it touched.
    """
    wanted = []
    if getattr(args, "audio_per_track", False):
        wanted += [(f"A{t.get('track')}", t, f"_track_A{t.get('track')}.mp3")
                   for t in (getattr(args, "track_audio", None) or [])]
    if getattr(args, "audio", False):
        wanted.append(("the mix", getattr(args, "timeline_audio", None) or {},
                       "_timeline_audio.mp3"))
    msgs = []
    bad = getattr(tl, "audio_unreadable", None) or {}
    if bad:
        names = sorted(f"{Path(p).name} ({w})" for p, w in bad.items())
        msgs.append(f"{len(bad)} audio source(s) could not be read by ffmpeg and are NOT in "
                    f"the audio files — the rest of the mix was written without them: "
                    + ", ".join(names[:4]) + (", …" if len(names) > 4 else ""))
    missing = [(who, res) for who, res, _ in wanted if not res.get("file")]
    if missing:
        msgs.append("audio NOT written for " + "; ".join(
            f"{who}: {res.get('note') or 'no audio items on the chosen tracks'}"
            for who, res in missing))
    # ⚠️ NEVER DELETED — never destroying earlier work is the rule the refused-clip case set
    # (see stale_delivery) — so it is SAID: a file under this run's name that this run did
    # not write is the previous edit's audio, and it looks exactly like a current one.
    stale = [name for _, res, name in wanted
             if not res.get("file") and (args.out / name).is_file()]
    if stale:
        msgs.append(f"{len(stale)} audio file(s) in the folder are from an EARLIER run, not "
                    f"this one — this run did not write them: " + ", ".join(stale))
    for m in msgs:
        tl.warnings.append(m)
        print(f"\n  !! {m}")


def parse_track_list(raw) -> set[int]:
    """"2" or "1,2" or "A2" -> {2} / {1, 2}. Empty means every track, which is the default: a
    flag that had to be given before audio worked at all would be a second switch.

    ⚠️ AN ENTRY IT CANNOT READ IS AN ERROR, NEVER A SKIP. Skipping was the old behaviour, and
    since empty means "every track", "A2 A3", "2-3" and "A2;A3" each parsed to nothing and
    mixed EVERY track — MEASURED: requested [], used [1, 2], the A1 music at full level in a
    mix whose author asked for VO and SFX, and no warning, because the missing-track warning
    only runs on a non-empty set. So the spellings people actually type are accepted (commas,
    semicolons or spaces between entries; "2-3" or "A2-A3" for a range), and anything else
    raises ValueError naming the entry, which main() turns into a refusal. The panel always
    sends "2,3", which this reads exactly as before.
    """
    if not raw or not str(raw).strip():
        return set()
    out = set()
    bad = []
    for part in re.split(r"[,;\s]+", str(raw).strip()):
        if not part:
            continue
        m = re.fullmatch(r"[Aa]?(\d+)(?:-[Aa]?(\d+))?", part)
        if not m:
            bad.append(part)
            continue
        lo = int(m.group(1))
        hi = int(m.group(2)) if m.group(2) else lo
        if lo < 1 or hi < lo:
            bad.append(part)
            continue
        out.update(range(lo, hi + 1))
    if bad:
        raise ValueError(f"cannot read {', '.join(repr(b) for b in bad)} as a track "
                         f"number — write e.g. \"2\", \"1,2\", \"A2 A3\" or \"2-3\"")
    return out


VO_RATE = 48000
VO_BITRATE = "192k"

# How close to full scale _timeline_audio.mp3 is allowed to sum. -1.0 dBFS rather than 0.0
# because an mp3 decoder's reconstruction overshoots the encoded samples slightly, and a mix
# that measured exactly 0.0 dBFS before encoding comes back over it.
TIMELINE_AUDIO_CEILING_DBFS = -1.0

_PEAK_LEVEL_RE = re.compile(r"Peak level dB:\s*(-?\d+(?:\.\d+)?|-?inf)")


def probe_audio_streams(path: str) -> tuple[Optional[list], str]:
    """The channel count of every audio stream in this file, in order — and why not.

    Returns (streams, reason):
      ([2], "")          one stereo stream
      ([1, 1], "")       two mono streams, a camera file's lav and boom
      ([], "…")          the file opens and has NO audio stream: a relinked picture file
      (None, "…")        ffprobe cannot open it at all: corrupt, half-synced, not media
      (None, "")         the probe itself did not run (timeout, no ffprobe) — unknown, and
                         unknown is NOT a reason to leave a part out; the mix goes ahead
                         and the channel count stays None, which means leave it alone.

    A reason is what write_timeline_audio leaves the part out for: the mix is one ffmpeg
    command, and either of the first two failure shapes fails it for every part.
    """
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                            "-show_entries", "stream=channels", "-of", "csv=p=0", path],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None, ""
    if r.returncode != 0:
        tail = (r.stderr or "").strip().splitlines()
        # ffprobe prefixes its reason with the full path; the note names the file already.
        why = tail[-1].split(": ", 1)[-1] if tail else ""
        return None, "unreadable" + (f": {why[:80]}" if why else "")
    streams = []
    for line in (r.stdout or "").splitlines():
        try:
            streams.append(int(line.strip().rstrip(",")))
        except ValueError:
            continue
    if not streams:
        return [], "no audio stream"
    return streams, ""


def mix_peak_dbfs(cmd: list[str], timeout: float) -> Optional[float]:
    """Run a built mix command to the null muxer and return the peak it reaches, in dBFS.

    The command is the REAL one, with its output path swapped for os.devnull, so the number
    measured is the number the second pass will produce — measuring a rebuilt approximation
    of the chain is how a gain stage ends up correcting something the encode never did.

    Measured on the SUM before the encode, not on the finished mp3: by then the samples are
    already clipped and a clipped file reports 0.0 dBFS no matter how far over it went.

    ⚠️ `astats` IN FLOAT, NOT `volumedetect`. volumedetect measures in fixed point and
    saturates: MEASURED on the two-source fixture at -0.2 dBFS per source it reported
    max_volume 0.0 dB for a sum that is genuinely +5.80 dB over, so the make-up from it
    was -1.0 dB and the delivered mp3 still peaked at 0.00 dBFS. `aformat=sample_fmts=fltp`
    ahead of astats keeps the sum in float, where Peak level dB reads above zero and the
    make-up lands.

    ⚠️ AND IT GOES INSIDE the filter_complex, not on `-af`. Measured: ffmpeg refuses the pair
    outright — "Simple and complex filtering cannot be used together for the same stream" —
    and exits non-zero, which this function would have read as "unmeasurable" and quietly
    skipped the whole gain stage.

    Returns None when ffmpeg or the parse fails, and None means "write it unchanged".
    """
    probe_cmd = list(cmd)
    try:
        i = probe_cmd.index("-map")
        j = probe_cmd.index("-filter_complex")
    except ValueError:
        return None
    # Everything after -map is the encode; replace it with a measurement and no file.
    probe_cmd = probe_cmd[:i + 2] + ["-f", "null", "-"]
    probe_cmd[j + 1] = (probe_cmd[j + 1] + ";[out]aformat=sample_fmts=fltp,"
                        "astats=measure_perchannel=none:"
                        "measure_overall=Peak_level[det]")
    probe_cmd[i + 1] = "[det]"
    probe_cmd[probe_cmd.index("-loglevel") + 1] = "info"
    # Tracked like the encode that follows it (see write_timeline_audio): a SIGTERM to the
    # engine alone otherwise left this ffmpeg running after the engine died. MEASURED in the
    # 3.89 merge review, 1200 s fixture: the orphan outlived the engine by ~2.8 s.
    try:
        r = _run_tracked(probe_cmd, timeout)
    except (OSError, subprocess.SubprocessError, StopRequested):
        return None
    if r.returncode != 0:
        return None
    m = _PEAK_LEVEL_RE.findall((r.stderr or "") + (r.stdout or ""))
    if not m or m[-1].endswith("inf"):
        return None
    return float(m[-1])


def vo_contributions(cut: Cut, items: list[Cut], seq_fps: float) -> tuple[list[dict], str]:
    """Which audio clipitems play across this cut, and where inside it they land.

    Everything is computed in TIMELINE frames, because that is the only clock the video track
    and the audio tracks share. A cut occupies [timeline_in, timeline_out); an audio item
    overlaps when its own span does, and the overlap's offset from the cut's start is where it
    belongs in the output.
    """
    out: list[dict] = []
    # What was left out, by reason and by name — see the note built at the bottom.
    left_out: list[tuple] = []
    ident = _mix_identities(items)
    c_in = cut.timeline_in_frames
    c_out = cut.timeline_out_frames or (c_in + max(1, cut.duration_frames))
    for a in items:
        a_in = a.timeline_in_frames
        a_out = a.timeline_out_frames or (a_in + max(1, a.duration_frames))
        # ⚠️ AN ITEM WHOSE MEDIA STARTS AFTER THE ITEM DOES. A clipitem with a NEGATIVE <in>
        # occupies its whole timeline slot but has no samples for the head of it — Premiere
        # plays nothing there. src_in used to be clamped to 0 on its own, leaving `at` and
        # `dur` untouched, so the mix started the media at the item's timeline start instead:
        # MEASURED with a click train on an item at timeline 0-2.0 s with <in> -12 (source
        # -0.4..1.6), the first click landed at 0.001 s where the edit played it at 0.4, and
        # a click at source 1.75 s the timeline never showed was mixed in at 1.75 s. The
        # per-clip file for the same item was right (1.600000 s, source 0.0..1.6), so the mix
        # and the clip it pairs with disagreed by the length of the negative head.
        #
        # Read TWO ways because this runs on items trim_to_whole_frames may or may not have
        # reached — the mix is built after the clamp, but an item --tracks dropped from the
        # cut list (kept here on purpose, see write_timeline_audio) never went through it.
        # Before the clamp the head is the negative in-point; after it, it is the gap the
        # clamp left between the slot and the shortened source range.
        lead = max(0.0, -(a.source_in_seconds or 0.0))
        if lead <= 0.0 and a.frames_trimmed:
            lead = max(0.0, (a_out - a_in) / seq_fps - (a.source_duration_seconds or 0.0))
        media_in = a_in + lead * seq_fps
        start = max(media_in, float(c_in))
        end = float(min(a_out, c_out))
        if end <= start:
            continue
        if not a.source_exists:
            left_out.append(("the source is missing", ident[id(a)], a))
            continue
        # ⚠️ A RETIMED AUDIO ITEM IS LEFT OUT, and said so rather than placed wrong. Putting it
        # in means reading a scaled source range and atempo-ing it back into its timeline slot;
        # getting that subtly wrong would slide the voice against the picture, which is worse
        # than a documented omission. Voice-over is not normally retimed — but SFX are, and
        # on real exports routinely (a zip at 150%, another at 71.43%), so "said so" has to
        # mean the clip's NAME, once per clip: see the note below.
        if abs((a.speed_percent or 100.0) - 100.0) > 0.01 or a.reversed:
            left_out.append(("retimed or reversed", ident[id(a)], a))
            continue
        out.append({
            "path": a.source_path,
            # Where in the SOURCE the overlap begins: the item's own in-point plus however far
            # into the item the overlap starts. Measured from where the MEDIA starts, not from
            # where the item does — the two differ by `lead` above, and at media_in the source
            # is at frame 0 whether the record still carries the negative in-point or the
            # clamp has already pulled it up to zero.
            "src_in": max(0.0, a.source_in_seconds) + (start - media_in) / seq_fps,
            "dur": (end - start) / seq_fps,
            # Where in the OUTPUT it goes. Silence everywhere else, which is the gap.
            "at": (start - c_in) / seq_fps,
            # ⚠️ THE FADER, carried per part because it is per part. Without it every
            # contribution was summed at unity through amix(normalize=0) and the mix bore
            # no relation to the balance the editor set: measured 15.14 dB of INVERTED
            # balance on a fixture whose voice sits 12 dB above its music bed.
            "gain": float(a.audio_level or 1.0),
            "gain_varies": bool(a.audio_level_varies),
            # Which channel of the file a MONO clip plays (see Cut.source_track); resolved
            # against the file's real streams in write_timeline_audio, once it is probed.
            "source_track": int(a.source_track or 1),
            "mono_clip": int(a.lane_count or 0) == 1,
            # The transition fades, re-expressed on THIS part's own clock: seconds from the
            # part's first sample. A part that starts inside a fade (clipped at frame 0, or
            # a negative in-point) begins it at zero gain rather than part-way up — afade
            # cannot start mid-ramp, and the case needs both to happen at once.
            "fades": _part_fades(a, max(0.0, a.source_in_seconds)
                                 + (start - media_in) / seq_fps),
            "_identity": ident[id(a)],
        })
    out.sort(key=lambda d: d["at"])
    # ⚠️ DE-DUPLICATED, and this is part of the numbering fix rather than a follow-up.
    # Grouping both lanes of a stereo pair into one Premiere track means a request for that
    # track now hands ffmpeg two inputs identical in all four fields, and amix(normalize=0)
    # sums them coherently for +6.02 dB — MEASURED as mean level −9.8 dB rising to −5.1 dB
    # with 758,060 samples pinned at 0 dBFS, 16.6% of the file. Shipping the grouping
    # without this replaces "the wrong track" with "the right track, clipped".
    #
    # ⚠️ ON THE FOUR-TUPLE, NOT ON "drop lanes whose cet != 0". A dual-mono clip routed to
    # take only channel 2 of its file would put genuinely different material in a non-zero
    # lane, and dropping by lane would lose it silently. Identical parts collapse; different
    # parts both survive. That case is MEASURED now, and the four-tuple alone did NOT keep it:
    # lav (sourcetrack 1) on A1 and boom (sourcetrack 2) on A2, one camera file, share all
    # four fields, and the boom was collapsed away as a "stereo lane". The track in the key
    # (below) is what keeps them apart; which channel each one plays is vo_mix_command's.
    #
    # ⚠️ AND ON THE TRACK. The four-tuple alone spanned tracks, so a clip DELIBERATELY laid
    # on two tracks — a doubled VO, an SFX copied at a second level — collapsed to one layer
    # under the "stereo lanes" note: MEASURED, a copy at 1.0 on A1 plus one at 0.5 on A2 mixed
    # at -0.3 dB against the source where Premiere sums them to +3.5 dB. The two lanes of a
    # stereo pair always share a premiere_track (premiere_track_numbers groups them), so the
    # track in the key costs the lane collapse nothing. _mix_identities says what "the same
    # clip" means when the XML carries no lane grouping at all.
    deduped: list[dict] = []
    seen_parts: set = set()
    for d in out:
        key = (d["_identity"], d["path"], round(d["src_in"], 6), round(d["dur"], 6),
               round(d["at"], 6))
        if key in seen_parts:
            continue
        seen_parts.add(key)
        deduped.append(d)
    collapsed = len(out) - len(deduped)
    lane_less = sum(1 for d in out if d["_identity"][0] == "lane-less") - sum(
        1 for d in deduped if d["_identity"][0] == "lane-less")
    out = deduped
    note = ""
    if collapsed:
        note = (f"{collapsed} duplicate audio part(s) collapsed — one stereo track "
                f"written as two identical lanes")
        # ⚠️ ON XML WITHOUT LANE GROUPING the collapse is a guess (see _mix_identities): a
        # copy of a clip at the same level on another track looks exactly like a stereo
        # lane. Say it may have been one, so a layer that went missing is traceable.
        if lane_less:
            note += (" (or the same clip copied at the same level onto another track: this "
                     "XML has no lane grouping to tell the two apart)")
    # ⚠️ COUNTED PER CLIP AND NAMED. `skipped` used to count LANES — one stereo SFX at 71%
    # read "2 audio item(s) left out" — and named nothing, so a track file with a silent gap
    # where a zip should be pointed at no clip at all. The same identity as the collapse
    # above, so the two lanes of one clip are one item here too.
    for why in ("retimed or reversed", "the source is missing"):
        mine = {}
        for w, ident, a in left_out:
            if w == why:
                mine.setdefault((ident, a.source_path, a.timeline_in_frames,
                                 a.timeline_out_frames), a)
        if mine:
            names = sorted({a.clip_name or Path(a.source_path).name or "(unnamed)"
                            for a in mine.values()})
            note = ((note + "; ") if note else "") + (
                f"{len(mine)} audio item(s) left out of the mix ({why}): "
                + ", ".join(names[:4]) + (", …" if len(names) > 4 else ""))
    return out, note


def _part_fades(a, part_src_in: float) -> list:
    """The clip's transition fades on one part's own clock: seconds from its first sample.

    A part that starts INSIDE a fade (clipped at frame 0, or a negative in-point) begins it at
    zero gain rather than part-way up: afade cannot start mid-ramp, and it takes both of those
    at once to reach this.
    """
    out = []
    for f in (a.audio_fades or []):
        st = max(f["src_start"], part_src_in)
        if f["src_end"] - st <= 1e-6:
            continue
        out.append({"type": f["type"], "curve": f["curve"],
                    "st": st - part_src_in, "d": f["src_end"] - st})
    return out


def _mix_identities(items: list) -> dict:
    """What makes two overlapping parts of one file the SAME clip in the mix, or two.

    With lane grouping in the XML (lane_count > 0) it is simply the Premiere track: the lanes
    of a stereo pair share one, and a copy on another track is another clip.

    Without it, every <track> is its own premiere_track, and an FCP7-style export writes a
    stereo pair as two of them. Keying on the track there would sum the pair to +6.02 dB, the
    defect the collapse exists to prevent. So a lane-less item's identity is its FADER: parts
    of one file, range and position collapse unless their levels differ.

    ⚠️ NOT "HOW MANY TIMES THIS SOURCETRACK HAS BEEN SEEN". That was the first attempt, on the
    theory that a pair is sourcetrack 1 + 2 and a copy is 1 + 1. A pair is NOT always 1 + 2:
    both lanes can carry trackindex 1, or no <sourcetrack> at all, and then the second lane
    counted as a deliberate copy and was summed — MEASURED with a 300 Hz left / 3 kHz right
    source, _timeline_audio.mp3 per channel went from -15.3 / -15.2 dB to -9.2 / -9.2 dB,
    +6 dB hot. The trackindex says nothing about pair-versus-copy on its own.

    ⚠️ WHAT THIS COSTS: a lane-less copy at the SAME level as the original is indistinguishable
    from the second lane of a stereo pair — same file, range, position and gain, nothing else
    in the XML to tell them apart — and it collapses, as it always did. vo_contributions says
    so in its note rather than blaming stereo lanes outright. A copy at a DIFFERENT level
    (the thickening trick F29 was measured on: 1.0 + 0.5) keeps both layers, because the two
    lanes of one stereo clip carry one level. None of the three real exports on hand has a
    lane without totalExplodedTrackCount, so this is a guard for the old shape (and for
    hand-written fixtures), not a rule a real export has exercised.

    Returns {id(item): identity}.
    """
    out: dict = {}
    for a in items:
        if int(a.lane_count or 0) > 0:
            out[id(a)] = ("track", int(a.premiere_track))
        else:
            out[id(a)] = ("lane-less", round(float(a.audio_level or 1.0), 6))
    return out


def vo_mix_command(cut: Cut, parts: list[dict], total: float, out_path: Path,
                   mix_gain_db: float = 0.0) -> list[str]:
    """One MP3, exactly `total` seconds long, holding every contribution at its own offset.

    The base input is SILENCE of the full length, and `amix=duration=first` pins the result to
    it — so a cut the voice-over does not cover comes out silent for that stretch instead of
    short. "contain all the VO, and the silince gap too": the gaps are the base showing through.

    ⚠️ `normalize=0` matters. amix divides by the number of inputs by default, so mixing one
    voice against the silent base would halve the voice, and a second overlapping line would
    halve it again — the level would depend on how many things happened to overlap.
    """
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "lavfi", "-t", f"{total:.6f}",
           "-i", f"anullsrc=r={VO_RATE}:cl=stereo"]
    for p in parts:
        # Same lead as the per-clip branch, trimmed back off in this part's chain below.
        p["_lead"] = min(AUDIO_SEEK_LEAD, float(p["src_in"]))
        if p["src_in"] - p["_lead"] > 1e-9:          # see the per-clip branch: -ss 0 still seeks
            cmd += ["-ss", f"{p['src_in'] - p['_lead']:.6f}"]
        cmd += ["-t", f"{p['dur'] + p['_lead']:.6f}", "-i", p["path"]]
    chains = []
    labels = ["[0:a]"]
    for i, p in enumerate(parts, start=1):
        ms = int(round(p["at"] * 1000))
        # ⚠️ THREE THINGS IN ORDER, and each was measured on a fixture whose two tones are
        # normalised to an identical peak by construction:
        #
        #   volume  — the Premiere fader for this part (see read_audio_level). Without it
        #             every part summed at unity and the delivered balance was 15.14 dB
        #             INVERTED against the edit: bed +3.10 dB over voice where Premiere has
        #             the voice 12.04 dB over the bed.
        #   pan     — MONO PARTS ONLY, and only when the probe actually said mono.
        #             libswresample's default mono->stereo rematrix is POWER-preserving, so
        #             a mono part arrives 3 dB under a stereo one of the same peak; measured
        #             -3.00 dB on the voice, and the voice is the mono one on every ordinary
        #             timeline, so the two errors compound in the same direction. An explicit
        #             copy to both channels restores unity exactly (measured -0.30 dB, which
        #             is the mp3 alone). NOT applied when the channel count is unknown: on a
        #             stereo input `c1=c0` would discard the right channel outright, so an
        #             unreadable probe must leave the signal alone.
        #   adelay  — unchanged; where in the output this part lands.
        #   stream/channel — a MONO clip's own channel of its file (see write_timeline_audio):
        #             the stream is picked on the input label, the channel inside it by the
        #             same explicit pan the mono up-mix uses, so the selected channel lands
        #             in both outputs at unity. None on both = the input as it always was.
        #   afade   — the clip's transition fades (audio_fades_for), on the part's own clock,
        #             after the level and before the delay so `st` counts from the part's
        #             first sample. None on the ordinary part, which keeps it byte-identical.
        _g = float(p.get("gain", 1.0) or 0.0)
        _pre = f"volume={_g:.6f}," if abs(_g - 1.0) > 1e-9 else ""
        _src = f"[{i}:a:{int(p['stream'])}]" if p.get("stream") is not None else f"[{i}:a]"
        _c = int(p.get("channel") or 0)
        _pan = (f"pan=stereo|c0=c{_c}|c1=c{_c},"
                if p.get("channels") == 1 or p.get("channel") is not None else "")
        _fade = "".join(
            f"afade=t={f['type']}:st={f['st']:.6f}:d={f['d']:.6f}:curve={f['curve']},"
            for f in (p.get("fades") or []))
        chains.append(f"{_src}atrim=start={p['_lead']:.6f}:end={p['_lead'] + p['dur']:.6f},"
                      f"asetpts=N/SR/TB,{_pre}aresample={VO_RATE},{_pan}{_fade}"
                      f"adelay=delays={ms}:all=1[v{i}]")
        labels.append(f"[v{i}]")
    chains.append("".join(labels)
                  + f"amix=inputs={len(labels)}:duration=first:normalize=0[out]")
    # ⚠️ THE MAKE-UP STAGE, which is the difference between a mix that documents its own
    # level and one whose level is an accident. amix(normalize=0) sums, so with commercially
    # mastered beds the sum runs off the top: MEASURED at +5.80 dBFS from two sources at
    # -0.2 dBFS, delivered at 0.00 dBFS — clipped — before this, and -1.30 dBFS after. Every
    # fixed-point consumer hard-clips that, and clipping is data loss nothing can undo, so
    # the mp3's own peak cannot be the measurement. `mix_gain_db` is
    # measured by write_timeline_audio in a first null pass and recorded in
    # settings.timeline_audio, so the file's level is a stated number rather than whatever
    # fell out. 0.0 emits nothing at all, which keeps a mix that never needed it byte-identical.
    _mix_db = float(mix_gain_db or 0.0)
    _tail = "[out]" if abs(_mix_db) <= 1e-9 else f"[mixed];[mixed]volume={_mix_db:.3f}dB[out]"
    chains[-1] = chains[-1][:-len("[out]")] + _tail
    cmd += ["-filter_complex", ";".join(chains), "-map", "[out]",
            "-t", f"{total:.6f}",
            "-c:a", "libmp3lame", "-b:a", VO_BITRATE, "-ar", str(VO_RATE), "-ac", "2",
            str(out_path)]
    return cmd


# ⚠️ audio_sidecar_command WAS DELETED HERE, not fixed. It built a per-cut voice file with
# `ss = cut.source_in_seconds - 0.5 / fps` — the video branch's half-frame lead, on an audio
# stream that is seeked to the SAMPLE, so it carried the identical straight offset the audio
# branch of build_command just lost (see the note there: measured 16.7-46.7 ms, never zero).
# It had NO CALL SITE anywhere in the engine, the panel or the tests, so leaving a corrected
# copy in place would only preserve a template of the defect for the next person to copy.
# The two live audio paths are build_command's audio branch and vo_mix_command, and both
# now seek exactly.


PROBE_SECONDS = 1.0
PROBE_SLICES = 3
PROBE_TIMEOUT = 25

# The mp4 container's own fixed cost, MEASURED rather than guessed: encoding the same source
# for 0.2/0.5/1/2/4 seconds and fitting size against duration gives 135633 bytes per second
# plus a 458-byte intercept. So it is ~460 bytes, not the 8192 the first version subtracted —
# which was 18x too much and made every short clip under-estimate by about 7%.
#
# It matters because it does NOT scale with duration. Stripped from each probe slice, then
# added back ONCE to the estimate; multiplying it up with the content rate is what produced
# the error.
CONTAINER_FIXED = 512

# What an audio-only delivery costs per second: the bitrate every audio branch of
# build_command asks ffmpeg for (`-c:a aac -b:a 192k`). A ceiling, not a fit — see
# estimate_bytes_for.
AUDIO_ESTIMATE_BPS = 192_000.0

# A still is probed whole rather than sampled (see size_probe). Bounded only so a
# pathologically long one cannot stall a scan; its frames after the first are nearly
# free, so this is generous rather than tight.
PROBE_STILL_MAX = 30.0


def size_probe(cut: Cut, args, seq_fps: float) -> None:
    """ENCODE one second of this clip and record what it cost per second.

    ⚠️ THE SOURCE'S OWN BITRATE IS NOT A BASIS FOR AN ESTIMATE, and the version of this
    function that used it was wrong by up to 200x on real footage. Measured on a 19-clip
    production timeline at crf 15.5, output rate as a multiple of the source's:

        h264   1080x1920, src 10-20 Mbps    0.55-1.09x    model said 1.16x   ~1.6x high
        h264   3840x2160, src 260 Mbps      0.30x         model said 1.16x   ~4x high
        prores 2000x2000, src 632-728 Mbps  0.006-0.008x  model said 1.16x   ~180x high

    An intraframe codec spends hundreds of megabits on a shot that x264 encodes in four,
    so its bitrate says nothing whatever about what H.264 will cost. Nor does resolution:
    bits per pixel at one crf ranged 0.065 to 0.308 across those same clips, a 5x spread,
    because that number IS content complexity and cannot be inferred from a container.

    So this measures. One second of the real clip, through the real build_command, at the
    real settings — the same encoder, filters and flags the export will use, which is why
    it is right rather than merely closer.

    ⚠️ SAMPLED IN SEVERAL PLACES, not just at the head. The first version took one second
    from the start and was out by 2.19x on a 9.4-second clip whose opening move is busier
    than the rest of it — a 10% sample of the least representative part. Up to three slices
    spread through the clip, so the estimate sees the quiet middle as well as the entrance.
    On the same 19 clips that took the worst case from 2.19x to within a fifth.

    Bounded on purpose: at most PROBE_SLICES short reads, each with a timeout. Media can
    live on a network share and a 728 Mbps ProRes read can stall; a probe that hangs
    would turn a scan into a wait with no explanation, so a timeout leaves probe_bps at 0
    and the caller falls back rather than blocking.
    """
    if cut.media_kind == "unsupported" or not cut.source_exists:
        return
    secs = cut.source_duration_seconds or 0.0
    if secs <= 0:
        return
    # ⚠️ pix_fmt_out is normally set by run_cut, which has not run yet — codec_flags reads
    # it and ffmpeg answers "Unknown pixel format requested: ." with exit 234. That failure
    # is SILENT by design here (a failed probe just falls back to the model), so the first
    # version of this shipped doing nothing at all while the fixture's estimates still
    # looked right, because the fixture is ordinary h264 where the model happens to work.
    # Set it the same way run_cut does, from the same function.
    if not cut.pix_fmt_out:
        cut.pix_fmt_out = pix_fmt_for(cut)
    # One slice for a short clip, up to three for a long one. A 2s clip IS its own sample;
    # a 10s clip is not.
    n = min(PROBE_SLICES, max(1, round(secs / 3.0)))
    span = min(PROBE_SECONDS, secs / n)
    # A STILL is measured in FULL, however long it is.
    #
    # Almost all of a still's file is its one keyframe; every frame after that is a few
    # bytes of "no change". So its cost is overwhelmingly FIXED, and sampling a second of
    # it and multiplying by the duration multiplies that keyframe up — a 1.5s still came out
    # 1.20x high and a 10s one would be far worse. Encoding the whole thing is affordable
    # precisely because the frames after the first are nearly free.
    if cut.media_kind == "still":
        n, span = 1, min(secs, PROBE_STILL_MAX)
    fps = cut.source_fps or seq_fps
    bits = 0.0
    sampled = 0.0
    for i in range(n):
        # Centre each slice in its own nth of the clip, so the slices are spread rather
        # than adjacent, and clamp so the last one cannot run off the end.
        at = cut.source_in_seconds + max(0.0, min(secs - span,
                                                  secs * (i + 0.5) / n - span / 2))
        stub = replace(cut, source_in_seconds=at, source_duration_seconds=span,
                       source_consumed_frames=max(1, int(span * fps)),
                       duration_frames=max(1, int(span * seq_fps)))
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / f"probe.{getattr(args, 'container', None) or 'mp4'}"
            try:
                r = subprocess.run(build_command(stub, out, args, seq_fps),
                                   capture_output=True, timeout=PROBE_TIMEOUT)
            except (subprocess.TimeoutExpired, OSError):
                return
            if r.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                return
            # Strip the container's fixed cost so probe_bps is CONTENT only. It is added
            # back once, in estimate_sizes — it does not scale with duration, and treating
            # it as if it did is what made short clips under-estimate.
            size = out.stat().st_size
            bits += max(0.0, size - CONTAINER_FIXED) * 8
            sampled += span
    if sampled <= 0:
        return
    cut.probe_bps = bits / sampled
    cut.probe_crf = float(crf_of(args))


def probe_sizes(cuts: list[Cut], args, seq_fps: float) -> None:
    """Every cuttable clip, probed in parallel — the same pool width as the export.

    ⚠️ NOT IN RENDER MODE, AND THAT IS DELIBERATE. The probe encodes a second of each
    SOURCE, but in render mode ffmpeg never opens the source: the pixels come back from
    Premiere at the sequence's frame size and rate, and estimate_sizes() prices those rows
    from the sequence. So the probe spent real encode time on a number that was then
    thrown away — measured, one clip probed at 794,472 bytes against a sequence estimate
    of 1,312,064 — while probe_bps went into the manifest for the panel to read, where it
    disagreed with the size the same manifest showed. Nothing to probe against: no probe.
    """
    if bool(getattr(args, "render_planned", False)
            or getattr(args, "render_dir", None)):
        return
    todo = [c for c in cuts
            if c.media_kind != "unsupported" and c.source_exists
            and (c.source_duration_seconds or 0) > 0]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=JOBS) as ex:
        for fut in as_completed([ex.submit(size_probe, c, args, seq_fps) for c in todo]):
            fut.result()


def estimate_sizes(cuts: list[Cut], args) -> None:
    """What each cut is expected to weigh, before the whole thing is encoded.

    Uses size_probe()'s MEASURED rate when there is one — that is the accurate path and
    the only one worth trusting. The source-bitrate model below is the fallback for
    --no-size-probe and for a clip whose probe failed, and it is kept only because a wrong
    number with a warning beats no number at all when someone is deciding whether to press
    Export. It is documented as unreliable in size_probe(); do not promote it.

      target bitrate   a CEILING, not an estimate. rate x seconds is what the encoder is
                       allowed to spend, and on short clips it routinely spends less
                       because the content does not need it:
                           4M  ~17.2 MB allowed, 10.7 MB actual  (62%)
                           1M   ~4.3 MB allowed,  3.5 MB actual  (81%)
                       Reported as "at most", since the shortfall depends on the footage
                       and there is no honest constant to calibrate it with.
    """
    rate = parse_bitrate(getattr(args, "bitrate", None) or "")
    ratio = size_ratio_for_crf(crf_of(args))
    # The encoder's own factor, for the last-resort branch below. The modelled branch gets
    # it inside estimate_bytes_for; this one is a bare rate x ratio and would otherwise be
    # the one place an x265 export was still priced as x264.
    crat = codec_ratio(vcodec_of(args), crf_of(args))
    pct = scale_of(args)
    # Bytes track PIXEL COUNT, so the factor is the scale SQUARED — measured across three
    # real cuts at 75/50/33%, where it held to within about a third and undershot on
    # detailed footage. Applied to the target-rate path too: -b:v is a rate the encoder
    # aims at whatever the frame size, so a downscaled clip does NOT get smaller in that
    # mode, and multiplying there would promise a saving the mode does not give.
    area = (pct / 100.0) ** 2
    # For the no-source branch below. Carried on args because that is what this function
    # already takes, and set once in main() from the timeline it belongs to.
    render_mode = bool(getattr(args, "render_planned", False)
                       or getattr(args, "render_dir", None))
    seq_w = int(getattr(args, "sequence_width", 0) or 0)
    seq_h = int(getattr(args, "sequence_height", 0) or 0)
    seq_fps = float(getattr(args, "sequence_fps", 0) or 0)
    for c in cuts:
        # A RENDER is a timeline range, so it is as long as the clip LOOKED and as big as
        # the sequence. A 2x sped-up 4K clip in a 1080 sequence eats two seconds of 4K
        # source and renders to one second of 1080; pricing that from the source would be
        # wrong on both counts, and the resolution readout would name the wrong pixels.
        in_w, in_h, _fps, _codec, _rate = encode_input(c)
        # ⚠️ A RENDER ROW IS PRICED FROM THE SEQUENCE, WHETHER OR NOT IT HAS A SOURCE, and
        # `track_type == "video"` is load-bearing rather than tidy: an audio cut has no
        # render coming, and pricing one by the sequence's PIXEL COUNT took a real
        # voice-over row from 44,995 to 656,288 bytes (14.6x) and gave it a frame size of
        # 640x360 in a column that should read 0x0.
        from_render = bool(c.render_path) or (render_mode and c.track_type == "video")
        # A render is a TIMELINE range: it is as long as the clip LOOKED, not as long as
        # the source it ate. A 2x sped-up clip consumes two seconds of source to occupy one
        # second of timeline, and pricing it over the source seconds overstates it by 2x.
        secs = (c.duration_seconds if from_render else c.source_duration_seconds) or 0.0
        c.output_width, c.output_height = scaled_dims(in_w, in_h, pct)
        # In render mode the source's own state no longer disqualifies a cut: the pixels
        # come from Premiere, so an offline clip or a Dynamic Link comp still has a file.
        unusable = (c.media_kind == "unsupported" or not c.source_exists)
        if secs <= 0:
            c.estimate_basis = "unknown"
            continue
        if from_render and not c.render_path and seq_w > 0 and seq_h > 0:
            # ⚠️ THE SEQUENCE, NOT THE SOURCE — and this gate used to read
            # `unusable and not c.render_path`, so it only ever ran for rows with NO
            # SOURCE AT ALL. Every render-mode row that did resolve a source fell through
            # and was priced from the camera file: the wrong frame size, the wrong frame
            # rate, and for a still the wrong model entirely (1.5 frames of jpeg against a
            # render that is N real frames of sequence-sized video).
            #
            # encode_input() cannot save it either: it returns the render's dimensions
            # only `if cut.render_path`, which is always "" during a scan — which is
            # exactly when the panel is showing these numbers to someone deciding whether
            # to press Export.
            #
            # The render IS the sequence, so it comes out at the sequence's frame size and
            # rate for as long as the clip sits on the timeline. Same bits-per-pixel model
            # as every other row, applied to the dimensions that actually decide this
            # output. Marked "sequence" so nobody reads it as having come from a source.
            #
            # ⚠️ seq_w/seq_h > 0 IS NOT BELT-AND-BRACES. DumpTimeline never assigns the
            # sequence size, so on the dump fallback path this clause is the only thing
            # that keeps every size cell from going blank: without a frame size there is
            # nothing to price, and the source-based branches below are the right answer.
            c.output_width, c.output_height = scaled_dims(seq_w, seq_h, pct)
            if rate:
                c.estimated_bytes = int(rate * secs / 8)
                c.estimate_basis = "ceiling"
                continue
            sw, sh = c.output_width, c.output_height
            bpp = _interp(BPP_INTER, crf_of(args))
            if c.media_kind == "still":
                # ⚠️ A RENDER OF A STILL IS STILL A STILL, and this is the one place the
                # first version of this branch got it badly wrong. The frame COUNT does go
                # up — the render is however many frames the graphic held on screen — but
                # those frames are identical, so all but the first cost a few bytes of
                # "nothing changed". MEASURED end to end at crf 18, on a real 45-frame
                # 640x360 render of the fixture's logo that actually weighs 3,142 bytes:
                #   priced as 45 frames of video   187,136 bytes   59.6x   ← the naive fix
                #   priced as STILL_FRAMES         ~  6,700 bytes    2.1x
                # So only the FRAME SIZE moves to the sequence, which is the correction
                # that mattered anyway: the source model was reading the logo's own
                # 320x240 into a column describing a 640x360 output.
                # No codec_ratio, for the same measured reason as estimate_bytes_for: a
                # still gives x265 no inter prediction to be better at.
                n_out = STILL_FRAMES
            else:
                bpp *= codec_ratio(vcodec_of(args), crf_of(args))
                n_out = (seq_fps or 25.0) * secs
            c.estimated_bytes = int(bpp * sw * sh * n_out / 8 + CONTAINER_FIXED)
            c.estimate_basis = "sequence"
            continue
        if unusable and not c.render_path:
            # NO SOURCE TO READ, and in source mode that really is the end of it: a nest
            # cut as one clip, an adjustment layer, a title and an offline clip all have no
            # source file, so every input the size model reads — dimensions, frame rate,
            # bitrate — is absent. Say so rather than invent a number.
            c.estimate_basis = "unknown"
            continue
        if rate:
            c.estimated_bytes = int(rate * secs / 8)
            c.estimate_basis = "ceiling"
        elif c.probe_bps > 0:
            # MEASURED, when --size-probe asked for it. The probe ran at THESE settings,
            # resolution filter included, so the area factor is already in the number and
            # must not be applied twice. The container's fixed cost is added once, not
            # scaled — see CONTAINER_FIXED.
            c.estimated_bytes = int(c.probe_bps * secs / 8 + CONTAINER_FIXED)
            c.estimate_basis = "measured"
        else:
            # The default: metadata only, so it costs nothing and a slider can follow it.
            modelled = estimate_bytes_for(c, crf_of(args), pct, secs,
                                          vcodec_of(args))
            if modelled > 0:
                c.estimated_bytes = int(modelled)
                c.estimate_basis = "source"
            elif c.bitrate:
                # No dimensions to work from — the last resort, and the unreliable one.
                c.estimated_bytes = int(float(c.bitrate) * ratio * crat * area * secs / 8)
                c.estimate_basis = "source"
            else:
                c.estimate_basis = "unknown"


RENDER_EXTS = (".mp4", ".mov", ".m4v", ".mxf", ".mkv")

# How far a render's length may sit from the cut it covers before it is refused. A real
# range can land a frame either side of the arithmetic; a render of the wrong range is
# out by hundreds, so this does not need to be tight to do its job.
RENDER_FRAME_SLACK = 2


# How far a cut may reach past the end of its own media before the run refuses it, in frames
# of the SOURCE's own rate. See apply_probe for why two: one for Premiere rounding a file's
# length up to a whole frame, one for the cut boundary landing either side of that.
OVERHANG_TRIM_FRAMES = 2


def _overhang_note(cut) -> str:
    """Why this cut came up short, when the reason is that the media ran out.

    Returns "" when the cut does not reach past its media, so the caller keeps its old
    wording — a shortfall in the MIDDLE of a readable range is a different problem and must
    not be explained away as an overhang.
    """
    over = float(getattr(cut, "overhang_seconds", 0.0) or 0.0)
    if over <= 0:
        return ""
    fps = getattr(cut, "source_fps", 0.0) or 0.0
    frames = f", {over * fps:.1f} frame(s)" if fps > 0 else ""
    return (f"this clip runs {over:.3f}s{frames} past the end of its media. Premiere "
            f"believes the file is longer than it is; trim the clip to the end of the "
            f"footage, or replace the media")


# Which warnings are advice rather than alarm. Matched on the phrase the advisory itself
# carries, not on a second field, because `warnings` is one list that the manifest, the
# panel rail and the console all read — a second class of record would have to be kept in
# step in three places, and the one that fell behind would be the one nobody saw.
ADVISORY_WARNING_MARKS = (
    "switch to Timeline Render",     # titles, graphics, adjustment layers: normal, not broken
    "none is needed in Timeline Render",   # the same clips, said to a render-mode run
    "were merged into it",           # Premiere's extra channel lanes of a clip already listed
    "nested sequence(s) skipped",    # --nest one-cut, which is a choice the caller made
    "reach the last frame of their media",   # Premiere counting a file longer than it is
    "correct as delivered",          # a tail overshoot, measured against the next render
    "stacked layers, not dissolves",  # an overlap with no transition: the edit's own doing
    "Nothing is decided on an estimate",   # a container that does not report its length
)


def is_advisory_warning(w: str) -> bool:
    """True when this warning describes the timeline rather than a problem with the run."""
    return any(m in (w or "") for m in ADVISORY_WARNING_MARKS)


def render_name(cut: Cut) -> str:
    """The basename a pre-rendered range for this cut must carry.

    (track type, track index, timeline IN, timeline OUT).

    ⚠️ THE OUT-POINT IS LOAD-BEARING, and it is here because a real timeline proved it.
    --pick identifies a clip by (type, track, in-point) on the reasoning that "two clips
    cannot start on the same frame of the same track". Under a TRANSITION they can: a
    cross-dissolve leaves the outgoing clip's overlap sitting at exactly the frame the
    incoming clip starts on. On one real client timeline that put a 10-frame tail of
    "K8 (before)" and an 88-frame "K8 (after)" both at frame 448 of V1.

    With the in-point alone, both cuts named the same render, so one of them was handed a
    file 78 frames longer than its own range. That was caught — the engine measures a
    render before it encodes it — but caught is not the same as correct, and the fix is
    for the name to say which range it covers rather than only where it starts.
    """
    return (f"{cut.track_type}-{int(cut.track_index)}-"
            f"{int(cut.timeline_in_frames)}-{int(cut.timeline_out_frames)}")


def attach_renders(cuts: list[Cut], render_dir: Path) -> tuple[int, list[Cut]]:
    """Point each cut at its pre-rendered timeline range, and probe what arrived.

    A render is Premiere's own output: the clip as it LOOKED, at the sequence's size and
    rate, with everything on it baked in. So its dimensions, rate, codec and length are
    the encoder's input and none of them can be inferred from the source clip — they are
    probed and recorded, one file at a time.

    Returns (matched, missing). A cut with no render is NOT quietly cut from its source
    instead: half a folder with effects and half without, all named alike, is a worse
    outcome than a clip that fails and says why. run_cut refuses them.
    """
    cache: dict = {}
    matched, missing = 0, []
    for c in cuts:
        # ⚠️ AUDIO CUTS ARE NOT RENDERED. Premiere renders picture ranges; an audio clipitem is
        # cut from its own source file in every mode, exactly as in Source Render. Looking for
        # a render here put every audio cut into `missing`, and run_cut then refused it with
        # "no render for this cut" — which is why a Timeline Render export could never carry
        # the per-track audio files the ticks ask for.
        if c.track_type == "audio":
            continue
        found = None
        for ext in RENDER_EXTS:
            p = render_dir / (render_name(c) + ext)
            if p.is_file() and p.stat().st_size > 0:
                found = p
                break
        if found is None:
            missing.append(c)
            continue
        c.render_path = str(found)
        matched += 1

        key = str(found)
        if key not in cache:
            cache[key] = probe(key)
        data = cache[key]
        for st in data.get("streams", []):
            if st.get("codec_type") != "video":
                continue
            c.render_width = st.get("width")
            c.render_height = st.get("height")
            c.render_codec = st.get("codec_name", "")
            try:
                n, d = st.get("r_frame_rate", "0/1").split("/")
                if float(d):
                    c.render_fps = round(float(n) / float(d), 6)
            except Exception:
                pass
            try:
                c.render_frames = int(st.get("nb_frames") or 0)
            except (TypeError, ValueError):
                c.render_frames = 0
            break
        br = data.get("format", {}).get("bit_rate")
        c.render_bitrate = int(br) if br else None
        if not c.render_frames:
            # nb_frames is missing from some containers. Duration x rate lands within a
            # frame, which is all this figure is used for — reporting a GROSS mismatch,
            # not deciding an encode. build_command pins the exact count regardless.
            #
            # ⚠️ AND IT IS FLAGGED, because 3.75 gave a one-frame disagreement teeth. The
            # duration here is the FORMAT's, i.e. the longest stream: a Matroska render
            # carrying AAC runs about 21 ms past its last picture, which at 30 fps is over
            # the half-frame rounding boundary, so an exact render reads as one frame long.
            # Measured by review: every cut in an .mkv export refused, in a folder where
            # nothing was wrong. A guessed count now says so and buys no refusals.
            dur = data.get("format", {}).get("duration")
            if dur and c.render_fps:
                try:
                    c.render_frames = int(round(float(dur) * c.render_fps))
                    c.render_frames_derived = True
                except ValueError:
                    pass
    return matched, missing


# ⚠️ THE ONLY PLACE THIS TOOL EVER LOOKS AT A PIXEL. Everything else it believes about a
# file comes from ffprobe metadata. Two frames are compared at 160x90, the size
# tests/verify.py has always used against real footage, so the numbers below sit against
# measurements that already exist rather than ones invented here.
#
# ⚠️ IN COLOUR, THOUGH, WHERE verify.py USES GRAY — and that is not a preference. Gray
# throws away chroma, and two DIFFERENT pictures can share a luma: measured on the first
# fixture built for this, a red frame (192,32,32) and a blue one (32,80,160) come out at
# luma 79.8 and 74.8, a distance of 5.0, under the "definitely different" threshold. The
# head overshoot was real and the test called it unclear. In rgb24 the same pair is 112.
# Colour can only ever move two different frames further apart and leaves two identical
# ones where they were, so the thresholds carry over unchanged.
HEADTRIM_SAME_MAE = 1.5      # at or under this, two frames are the same picture
HEADTRIM_APART_MAE = 6.0     # at or over this, they are definitely different pictures
# Between the two the answer is "cannot tell", and a cut that cannot tell is refused.
# The 8 Sep investigation measured a matching frame at 0.26 and a non-matching one at 9.56
# on real delivered clips, so the gap the thresholds sit in is wide. They are deliberately
# strict at both ends: being too strict costs a refusal, which is the outcome already
# chosen for the unclear case, while being too loose ships a clip trimmed at the wrong end
# — the exact failure this whole mechanism exists to prevent.


def render_frames_rgb(path: str, indexes: list[int],
                      timeout: float = 120.0) -> dict[int, bytes]:
    """Decode the named frames of one file as 160x90 rgb24, in one pass.

    ⚠️ ONE PASS, BECAUSE `select` DOES NOT SEEK. `select='eq(n,N)'` is a filter: ffmpeg
    decodes every frame from zero and discards the ones that do not match, so asking for
    frame 0 and frame 900 separately costs two full decodes of the same file. Asking for
    both in one expression costs one. Nothing else in the repo combines -ss with a
    single-frame read, and -ss on a render would reintroduce the second-vs-frame rounding
    this whole mechanism exists to remove — so the filter is the right tool and batching
    is how it is paid for.

    Returns {index: bytes}; an index whose frame did not come back is simply absent, and
    every caller treats a missing frame as "cannot tell" rather than as a match.
    """
    want = sorted({i for i in indexes if i >= 0})
    if not want:
        return {}
    expr = "+".join(f"eq(n\\,{i})" for i in want)
    try:
        r = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path),
             "-vf", f"select='{expr}',scale=160:90,format=rgb24",
             "-fps_mode", "passthrough", "-frames:v", str(len(want)),
             "-f", "rawvideo", "-"],
            capture_output=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return {}
    size = 160 * 90 * 3
    data = r.stdout or b""
    out: dict[int, bytes] = {}
    for slot, idx in enumerate(want):
        chunk = data[slot * size:(slot + 1) * size]
        if len(chunk) == size:
            out[idx] = chunk
    return out


def frame_mae(a: bytes, b: bytes) -> Optional[float]:
    """Mean absolute difference between two equal-length rgb frames, or None."""
    if not a or not b or len(a) != len(b):
        return None
    return sum(abs(x - y) for x, y in zip(a, b)) / float(len(a))


class _FolderNeighbour:
    """A neighbour that exists on disk but not in this run's cut list.

    ⚠️ --pick IS WHY THIS EXISTS. The panel's subset tick — and the Retry button on a failed
    row, which is the only affordance offered there — narrows tl.cuts before renders are ever
    attached, so the adjacent cut's ROW is gone while its render is still sitting in the
    folder. The neighbour test then found nothing, the cut was refused, and pressing Retry
    reproduced the refusal by construction: the more you narrowed the selection, the less
    evidence the engine would look at. Reproduced by review — the same bytes repaired in a
    full run and refused in a picked one.

    The folder is the better source anyway. render_name() spells every file
    `{track_type}-{track_index}-{in}-{out}`, so the filenames ARE the timeline, independent
    of which rows this run happens to be carrying.
    """

    __slots__ = ("render_path", "render_frames")

    def __init__(self, path: str, frames: int):
        self.render_path = path
        self.render_frames = frames


def _neighbour_on_disk(cut: Cut, side: str, render_dir: Optional[Path],
                       known: Optional[set] = None) -> Optional[_FolderNeighbour]:
    """The render abutting this cut on the given side, read off the folder's filenames.

    `known` is every (track_type, track_index, in, out) the TIMELINE holds, captured before
    --ext and --pick narrowed the cut list. A file whose range is not in there is a leftover
    from an earlier edit; see the note at the capture site for why accepting one is not a
    harmless miss but a systematic push toward a wrong repair.
    """
    if render_dir is None:
        return None
    edge = cut.timeline_in_frames if side == "prev" else cut.timeline_out_frames
    prefix = f"{cut.track_type}-{int(cut.track_index)}-"
    hits = []
    for ext in RENDER_EXTS:
        pattern = (f"{prefix}*-{edge}{ext}" if side == "prev"
                   else f"{prefix}{edge}-*{ext}")
        for f in render_dir.glob(pattern):
            bits = f.stem[len(prefix):].split("-")
            if len(bits) != 2:
                continue
            try:
                a, b = int(bits[0]), int(bits[1])
            except ValueError:
                continue
            if b <= a:
                continue
            if known is not None and (cut.track_type, int(cut.track_index), a, b) not in known:
                continue
            hits.append((f, b - a))
    # Exactly one candidate, exactly as the in-memory rule requires. Two files claiming the
    # same boundary is a timeline this test has no business guessing about.
    if len(hits) != 1:
        return None
    path, want = hits[0]
    data = probe(str(path))
    frames = 0
    for st in data.get("streams", []):
        if st.get("codec_type") != "video":
            continue
        try:
            frames = int(st.get("nb_frames") or 0)
        except (TypeError, ValueError):
            frames = 0
        break
    # nb_frames only — never the duration x rate guess. A ruler whose own length was
    # estimated cannot measure a one-frame error, and the neighbour's render has to be
    # EXACT to be a ruler at all.
    if frames <= 0 or frames != want:
        return None
    return _FolderNeighbour(str(path), frames)


def resolve_render_overshoot(cuts: list[Cut], render_dir: Optional[Path] = None,
                             known_ranges: Optional[set] = None) -> None:
    """Decide, from the pixels, WHICH END a too-long render overshot at.

    ⚠️ THE DEFECT THIS EXISTS FOR. Premiere sometimes hands back a render one frame longer
    than the range it was asked for. The encode pins -frames:v to the cut's own length with
    no seek, so ffmpeg keeps the FIRST N frames — which is right if the extra frame is at
    the tail and wrong at every single frame if it is at the head. Measured on 12 real
    exports: 1 render-mode clip in 140, delivered `status ok`, `frame_exact true`, notes
    empty, holding timeline 972..1049 under a label that says 973..1050.

    ⚠️ AND THE RULE IS EVIDENCE, NOT ARITHMETIC. There is nothing in the numbers that says
    which end overshot; the answer is in the pixels, and the reference is the NEIGHBOURING
    RENDER. In render mode the picture carries Premiere's colour, titles, Motion and ramps,
    so the raw source cannot be a reference — but the cut before this one was exported by
    the same encoder from the same timeline, and if this render overshot at the head then
    its first frame IS the frame that render ends on.

        head  <=>  C[0] is the same picture as PREV[last]  AND  C[1] is not
        tail  <=>  C[last] is the same picture as NEXT[0]   AND  C[last-1] is not

    The second half of each test is what makes it evidence rather than a coincidence. On a
    locked-off shot every frame matches every other frame, so both halves fire, the test is
    inconclusive by construction, and the clip is refused. That is the intended outcome and
    not a gap: refusing costs a re-render of one range, while guessing ships a clip trimmed
    at the wrong end, which is indistinguishable from the bug.

    Anything less than unambiguous is "unclear": no neighbour, a neighbour that is not
    exactly adjacent (a cross-dissolve makes the ranges OVERLAP, so "the frame before" is
    not a single frame), a neighbour whose own render is not exact, or a frame that would
    not decode. Every one of those refuses the cut in run_cut rather than delivering
    something unverified.

    ⚠️ A CROSS-DISSOLVE BOUNDARY CAN NEVER BE RESOLVED, and that is a consequence rather
    than an oversight. Under the default --transitions ignore the two clips OVERLAP, so
    nothing abuts this cut and there is no neighbour to find; under --transitions split they
    abut at the midpoint, but the frames either side are both the blended program, so the
    "and the frame beside it is different" half measures how much a dissolve moves in one
    frame rather than whether the shot changed, and it does not clear the threshold. Either
    way the answer is "cannot tell", and a +1 render on a dissolve-adjacent clip is refused.
    That is the right answer — under a dissolve "the frame before" is genuinely not a single
    frame — but it means those clips need a re-render rather than a repair.

    ⚠️ ONLY +1 IS EXAMINED, AND THE LIMIT IS DELIBERATE. A render two frames long could be
    one at each end, two at the head or two at the tail, and the two-frame test above cannot
    separate those — so it would report "unclear" on every one of them, turning
    RENDER_FRAME_SLACK from a documented tolerance into a refusal without anyone deciding
    that. Those still ship with the warning they have always had. Whether they should is a
    real question and a separate one: it changes a policy that predates this mechanism, has
    its own rationale and its own tests, and the answer is not implied by the answer here.
    """
    todo = [c for c in cuts
            if c.render_path and c.render_frames and c.duration_frames
            and not c.render_frames_derived
            and c.render_frames - c.duration_frames == 1]
    if not todo:
        return
    # Grouped exactly as split_transition_overlaps and overlapping_cut_frames group, so
    # "the same track" means the same thing here as everywhere else in the file.
    by_track: dict[tuple, list[Cut]] = {}
    for c in cuts:
        by_track.setdefault((c.track_type, int(c.track_index)), []).append(c)

    def _lone_neighbour(cut: Cut, side: str) -> Optional[Cut]:
        peers = by_track.get((cut.track_type, int(cut.track_index)), [])
        if side == "prev":
            hits = [p for p in peers if p is not cut
                    and p.timeline_out_frames == cut.timeline_in_frames]
        else:
            hits = [p for p in peers if p is not cut
                    and p.timeline_in_frames == cut.timeline_out_frames]
        # Exactly one, and its own render has to be trustworthy before its frames can be
        # used as a ruler. A neighbour that is itself mis-sized proves nothing.
        #
        # ⚠️ THIS GUARD IS NOT PINNED BY A TEST, and that is stated rather than hidden.
        # Removing it leaves tests/check_render_mode.py entirely green — measured. The
        # fixtures there build every render as one flat colour, so a mis-sized neighbour's
        # last frame is still the right COLOUR and the ruler still reads true; every
        # scenario that would separate the two comes out "unclear" either way. It is kept
        # because using a ruler known to be the wrong length to measure a one-frame error
        # is unsound on its face, not because a red check demanded it.
        hits = [h for h in hits if h.render_path and h.render_frames
                and h.render_frames == h.duration_frames]
        return hits[0] if len(hits) == 1 else None

    def _side(edge: Optional[bytes], inner: Optional[bytes],
              ref: Optional[bytes]) -> Optional[bool]:
        """Did THIS end overshoot? True yes, False no, None cannot tell.

        ⚠️ THREE ANSWERS, NOT TWO, AND THAT IS THE WHOLE POINT. The first version of this
        returned a bool, so "the neighbour's render contradicts an overshoot at this end"
        and "there is no neighbour, so this end was never examined" were the same value —
        False. The verdict below then read `head and not tail`, and an unexamined side
        counted as a side that had DISAGREED. One unopposed match therefore decided the
        case, which is exactly the guessing this mechanism exists to replace.

        Reproduced by an adversarial review, twice, in both directions: a genuine TAIL
        overshoot on the last clip of a track — no next neighbour, so the tail test could
        not run — whose first frame repeated the previous shot's last frame (a one-frame
        black hold at a scene change, a held graphic, a duplicated frame from a 24-into-30
        conform) was declared a HEAD overshoot, trimmed at the wrong end, and delivered
        `status ok`, `frame_exact true`, under a warning saying it had been verified.

        So: `edge` is the frame at this end, `inner` the one beside it, `ref` the
        neighbour's frame across the boundary. An overshoot needs the edge frame to BE the
        neighbour's and the inner frame not to be. A denial needs the edge frame to be
        plainly not the neighbour's. Anything else — a missing frame, a missing neighbour,
        two distances in the band between the thresholds — is None, and None on either
        side refuses the cut.
        """
        if edge is None or inner is None or ref is None:
            return None
        d_edge, d_inner = frame_mae(edge, ref), frame_mae(inner, ref)
        if d_edge is None or d_inner is None:
            return None
        if d_edge <= HEADTRIM_SAME_MAE and d_inner >= HEADTRIM_APART_MAE:
            return True
        if d_edge >= HEADTRIM_APART_MAE:
            return False
        return None

    for c in todo:
        prev = (_lone_neighbour(c, "prev")
                or _neighbour_on_disk(c, "prev", render_dir, known_ranges))
        nxt = (_lone_neighbour(c, "next")
               or _neighbour_on_disk(c, "next", render_dir, known_ranges))
        last = c.render_frames - 1
        # ⚠️ NOT DECODED UNTIL BOTH NEIGHBOURS ARE THERE. Reading the subject render costs a
        # full decode of the file, because `select` does not seek — and with a neighbour
        # missing on either side the verdict is "unclear" whatever the pixels say, so every
        # one of those frames would be decoded to reach a conclusion already known. Measured
        # by review on a 200-clip export: the wasted decode is the whole file, per clip.
        head = tail = None
        # ⚠️ WHY A SIDE IS MISSING IS TWO DIFFERENT FACTS, and the first version told the
        # editor the same sentence for both. "There is no clip there" — the cut opens or
        # closes the track, or a gap or a dissolve sits at that boundary — is a property of
        # the EDIT and means re-rendering will not help. "The clip is there but its render
        # cannot be used as a ruler" — it is missing, or itself the wrong length — is a
        # property of the FOLDER and often means re-rendering the neighbour fixes this cut
        # too. Review reproduced the refusal naming a clip that does not exist.
        def _absent(side: str) -> str:
            peers = by_track.get((c.track_type, int(c.track_index)), [])
            if side == "prev":
                touching = [p for p in peers if p is not c
                            and p.timeline_out_frames == c.timeline_in_frames]
            else:
                touching = [p for p in peers if p is not c
                            and p.timeline_in_frames == c.timeline_out_frames]
            where = "before" if side == "prev" else "after"
            if not touching:
                return (f"nothing on this track abuts it {where} — it is at the edge of the "
                        f"track, or a gap or a dissolve sits at that join")
            if len(touching) > 1:
                return f"more than one clip claims the join {where} it"
            return (f"the clip {where} it has no usable render — missing, or not the length "
                    f"of its own cut")

        why = ""
        if prev is None or nxt is None:
            _bits = ([_absent("prev")] if prev is None else []) + \
                    ([_absent("next")] if nxt is None else [])
            why = "; ".join(_bits)
        if prev is not None and nxt is not None:
            mine = render_frames_rgb(c.render_path, [0, 1, last - 1, last])
            pr = render_frames_rgb(prev.render_path, [prev.render_frames - 1])
            nx = render_frames_rgb(nxt.render_path, [0])
            head = _side(mine.get(0), mine.get(1), pr.get(prev.render_frames - 1))
            tail = _side(mine.get(last), mine.get(last - 1), nx.get(0))
            # ⚠️ "ffmpeg NEVER ANSWERED" IS NOT "THE PICTURE SAYS NOTHING". render_frames_rgb
            # returns what it managed to decode, so a timeout, a half-downloaded render or a
            # non-zero exit arrives here as an empty dict — indistinguishable, until now,
            # from two frames that genuinely look alike. The refusal then told the editor
            # the surplus frame "could not be placed from the picture", about a picture
            # nothing had read. Flagged by review; the outcome is the same refusal, but the
            # sentence now names the real obstacle.
            if not mine or not pr or not nx:
                why = ("its render, or a neighbouring one, could not be decoded — the file "
                       "may still be downloading")
            elif head is None or tail is None:
                why = ("the shots on either side of it look too alike to tell the surplus "
                       "frame from a real one")
            else:
                why = "both ends of the render match their neighbour equally well"
        # BOTH sides must have answered, and they must disagree. One end saying "the
        # surplus frame is mine" while the other has not been asked is not evidence.
        if head is True and tail is False:
            c.render_overshoot, c.render_head_trim = "head", 1
        elif tail is True and head is False:
            c.render_overshoot, c.render_head_trim = "tail", 0
        else:
            c.render_overshoot, c.render_head_trim = "unclear", 0
            c.render_overshoot_why = why


def collapse_exploded_audio_lanes(cuts: list[Cut]) -> tuple[list[Cut], list[dict]]:
    """One clipitem on one Premiere AUDIO track becomes ONE cut, not one per channel.

    ⚠️ THE BUG, MEASURED ON A STEREO TIMELINE. Premiere writes one <track> per audio
    CHANNEL — Timeline.premiere_track_numbers documents 9 lanes for 4 tracks on the one
    real export — and cut construction emits a Cut per clipitem per lane with nothing
    collapsing them. So a two-lane track holding three clips gave SIX cuts in three
    byte-identical pairs: six rows in the panel's list, six entries in the pick file, six
    files on disk. Meanwhile args.audio_tracks_available de-duplicated its own count, so
    the panel offered "A2 · 3 items" and ticking it delivered six — the menu and the
    delivery disagreed by a factor of two and neither said so.

    Nothing downstream reads <sourcetrack>, so both halves of a pair are the same
    full-width cut of the same source range: the second file is a redundant copy of the
    first, exactly as _drop_duplicate_cuts describes for stacked nest layers.

    THE GROUPING IS PREMIERE'S OWN. premiere_track already carries the A-number derived
    from currentExplodedTrackIndex — that logic is not re-derived here, it is read. Two
    cuts on DIFFERENT Premiere tracks that merely share a source range are two different
    clips (the same music bed under two shots, one on A2 and one on A3) and keep their
    keys: premiere_track is in the identity.

    WHY track_index IS NOT IN THE IDENTITY, and this is the whole point: the lane ordinal
    is the ONLY field two exploded halves differ in. It stays on the surviving cut, which
    is the LOWEST lane of the group — the one Premiere writes first — so pick_key,
    render_name and the panel's clipKey keep reading a lane ordinal and stay unique.
    Nothing is renumbered.

    EVERY OTHER FIELD THAT COULD MOVE A BYTE OR A LABEL KEEPS BOTH CUTS, the same rule
    _drop_duplicate_cuts states: name, timeline range, source path, source range, speed,
    reverse, enabled, the nest it came out of, and the audio fader (a level that differs
    per channel is a mix this pass must not average away).

    A TIMELINE WITH NO EXPLODED LANES CANNOT BE TOUCHED BY THIS, by construction rather
    than by luck: with the attribute absent premiere_track_numbers returns 1..n, so
    premiere_track == track_index, so two cuts sharing premiere_track share their lane
    ordinal too — and _drop_duplicate_cuts has already removed any pair identical in
    every remaining field. Measured on tests/PROMO_MASTER_v7.xml: 0 merged.

    Returns (kept, merged), where merged records what went and what it merged into, so the
    manifest can say WHICH clips collapsed rather than only that a number moved.
    """
    seen: dict = {}
    keep: list[Cut] = []
    merged: list[dict] = []
    for c in cuts:
        if c.track_type != "audio":
            keep.append(c)
            continue
        key = (int(c.premiere_track),
               c.clip_name or "",
               c.timeline_in_frames, c.timeline_out_frames,
               c.source_path,
               round(c.source_in_seconds or 0.0, 6),
               round(c.source_duration_seconds or 0.0, 6),
               round(c.speed_percent or 100.0, 6),
               bool(c.reversed),
               bool(c.enabled),
               c.nested_from or "",
               round(c.audio_level or 1.0, 9),
               bool(c.audio_level_varies))
        first = seen.get(key)
        if first is not None:
            merged.append({
                "name": c.clip_name or "(unnamed)",
                "track": f"A{int(c.premiere_track)}",
                "lane": int(c.track_index),
                "kept_lane": int(first.track_index),
                "in": c.timeline_in_frames,
                "out": c.timeline_out_frames,
            })
            continue
        seen[key] = c
        keep.append(c)
    return keep, merged


def overlapping_cut_frames(cuts: list[Cut]) -> tuple[int, int]:
    """(pairs of cuts sharing at least one frame, distinct frames held by more than one).

    ⚠️ NOT A FAULT REPORT. With --transitions ignore — the default — each cut is the
    clipitem's own in/out, and Premiere represents a cross-dissolve by overlapping the two
    clips by the transition's length, so both of them genuinely hold the blended frames.
    Sharing is the accepted consequence of cutting exactly what the editor drew.

    It is measured and recorded because somebody training on a folder of these files cannot
    discover it by looking: the clips are all the right length, correctly named, and the
    duplication is a couple of dozen frames deep inside two of them. A number in the
    manifest is the only way to find it without diffing pixels.

    Ranges are half-open [in, out), the same convention duration_frames uses. Counted per
    track, because two cuts on different tracks are different pictures at the same instant
    rather than the same picture twice.
    """
    groups: dict = {}
    for c in cuts:
        groups.setdefault((c.track_type, int(c.track_index)), []).append(c)

    pairs = 0
    frames = 0
    for key in sorted(groups):
        row = sorted(groups[key],
                     key=lambda c: (c.timeline_in_frames, c.timeline_out_frames))
        for i, a in enumerate(row):
            for b in row[i + 1:]:
                # In-points only increase, so once one clears a's out-point they all do.
                if b.timeline_in_frames >= a.timeline_out_frames:
                    break
                if min(a.timeline_out_frames, b.timeline_out_frames) > b.timeline_in_frames:
                    pairs += 1

        # DISTINCT frames, by sweep. Adding up each pair's overlap would count a frame
        # twice where three cuts meet, which is exactly the case a stacked nest produces.
        events: list[tuple[int, int]] = []
        for c in row:
            if c.timeline_out_frames > c.timeline_in_frames:
                events.append((c.timeline_in_frames, 1))
                events.append((c.timeline_out_frames, -1))
        events.sort()
        depth = 0
        prev = events[0][0] if events else 0
        i = 0
        while i < len(events):
            pos = events[i][0]
            if depth >= 2:
                frames += pos - prev
            while i < len(events) and events[i][0] == pos:
                depth += events[i][1]
                i += 1
            prev = pos
    return pairs, frames


def split_transition_overlaps(cuts: list[Cut], seq_fps: float) -> int:
    """Where two cuts on one track OVERLAP, move the boundary to the middle of the overlap.

    Premiere represents a cross-dissolve as the two clips overlapping by the transition's
    length, so both of them genuinely occupy those frames. In source mode that is harmless:
    each clip is cut from its own camera file and the overlap shows its own un-blended
    footage. In render mode it is not, because a render IS the timeline — on a real
    client edit, cut 18 (1051-1071) and cut 19 (1058-1152) came out holding the same
    thirteen frames, pixel for pixel, both showing the dissolve mid-blend.

    Splitting at the midpoint keeps every frame exactly once and puts the cut where the
    blend is half done, which is roughly where the eye reads it. The alternative — dropping
    the overlap from both — loses every transition frame in the dataset.

    Per TRACK, and for every video track rather than only the master: overlaps can only
    happen within a track, and doing them all means the scan and the export compute the
    same ranges without the scan needing to know which track is master. They must agree
    exactly, because the render's FILENAME is built from these numbers on one side and
    looked up by them on the other.

    Returns the number of boundaries moved. Overlaps with no transition at the boundary are
    left alone and counted into `split_skipped_stacked` on the module-level record below, so
    a run can say how many it declined to touch.
    """
    groups: dict = {}
    for c in cuts:
        if c.track_type != "video":
            continue
        groups.setdefault((c.track_type, int(c.track_index)), []).append(c)

    moved = 0
    skipped_no_transition = 0
    for key in sorted(groups):
        row = sorted(groups[key], key=lambda c: (c.timeline_in_frames, c.timeline_out_frames))
        for a, b in zip(row, row[1:]):
            if b.timeline_in_frames >= a.timeline_out_frames:
                continue                            # no overlap: an ordinary cut
            # ⚠️ EVIDENCE THAT IT IS A TRANSITION, NOT JUST THAT IT OVERLAPS. Two cuts on one
            # track can overlap for two unrelated reasons, and this function used to treat
            # them as one. A cross-dissolve overlaps because Premiere writes it that way.
            # STACKED LAYERS overlap because they are on top of each other — and _parse_nested
            # puts every inner track of a resolved nest onto the PARENT's single track index
            # (see its note), so a nest holding two stacked layers arrives here looking exactly
            # like a dissolve. Splitting those moves a boundary that was never a boundary, and
            # _parse_nested's own comment records the measurement: on one real nest, 2 of its
            # 6 overlapping pairs were not dissolves.
            #
            # ⚠️ transition_in / transition_out, NOT edge_in_transition. The first cut of
            # this gate used the latter and broke three suites, correctly: edge_in_transition
            # records that an edge was RECONSTRUCTED from a `-1`, which happens only when
            # Premiere left the boundary open. A dissolve whose two clipitems both carry
            # explicit boundaries has a <transitionitem> and no reconstructed edge at all, so
            # that test called a real dissolve a stacked layer. transition_in/out are set from
            # the <transitionitem> itself (see _parse_clipitem), which is the actual question.
            #
            # One side is enough: Premiere writes only one facing edge as -1 on some
            # dissolves, and the名 of the transition lands on whichever side it touched.
            if not (a.transition_out or b.transition_in):
                skipped_no_transition += 1
                continue
            # floor, so the result is the same on every run and on both sides
            mid = (b.timeline_in_frames + a.timeline_out_frames) // 2
            # A boundary that would leave either side shorter than a frame is left alone:
            # a cut with no frames in it is worse than a duplicated one.
            if mid - a.timeline_in_frames < 1 or b.timeline_out_frames - mid < 1:
                continue
            a.transition_split += a.timeline_out_frames - mid
            a.transition_split_end = "both" if a.transition_split_end == "head" else "tail"
            b.transition_split += mid - b.timeline_in_frames
            b.transition_split_end = "both" if b.transition_split_end == "tail" else "head"
            a.timeline_out_frames = mid
            b.timeline_in_frames = mid
            moved += 1

    if moved:
        for c in cuts:
            if c.track_type != "video" or not c.transition_split:
                continue
            # Everything derived from the range follows it. The timecodes especially: they
            # are what the sheet and the tooltip print, and a cut whose timecode disagreed
            # with its own frames would be unreadable.
            c.duration_frames = max(1, c.timeline_out_frames - c.timeline_in_frames)
            c.duration_seconds = round(frames_to_seconds(c.duration_frames, seq_fps), 6)
            c.timeline_in_tc = frames_to_tc(c.timeline_in_frames, seq_fps)
            c.timeline_out_tc = frames_to_tc(c.timeline_out_frames, seq_fps)
    split_transition_overlaps.skipped_stacked = skipped_no_transition
    return moved


def trim_to_whole_frames(cuts: list[Cut], warnings: Optional[list] = None) -> int:
    """Pull every cut back to whole frames: the frame Premiere SHOWED at the in-point,
    through the last frame that ends inside its own source range.

    "for any cut that the start frame land on an non rounded integer you move it up by 1 (+1) and
    end frame that not rounded you move it down by 1 (-1) so the cut dont get move outside each
    safe source range" — 18 Aug.

    A tick-derived in-point almost never lands on a frame boundary, and only the END of the
    range is fractional in a way the timeline never used — so only the end moves DOWN.

    ⚠️ THE HEAD RULE LIVES AT THE `first = math.ceil(...)` LINE BELOW, AND ONLY THERE. A
    paragraph here used to argue the opposite — that the head floors — as the rationale of a
    change that was made and then reverted on 26 Aug; the ceil beneath it has shipped since
    3.62 and is the owner's ruling. Two statements of one rule is how a reader ends up
    flipping the head back and silently moving every fractional-in-point cut by a frame,
    so the dead one is gone rather than reconciled.

    ⚠️ APPLIED TO THE CUT, not inside build_command, and that is the whole reason it is a
    separate pass. The manifest reports source_consumed_frames as the file's label and verify.py
    checks the file against it; the filename carries the (in-out) range. Trimming only the ffmpeg
    command would have left all three describing a file that no longer matched.

    The whole-frame SNAP is skipped for stills (no source frames to speak of), for audio (no
    frames at all) and for any cut a trim would leave shorter than one frame — losing a clip
    entirely to a rounding rule would be a worse answer than keeping its edges. The frame-0
    CLAMP is not skipped for audio: see the branch below.
    """
    e = 1e-4
    n_touched = 0
    clamped: list[str] = []
    for c in cuts:
        fps = c.source_fps or 0.0
        if c.track_type == "audio":
            # ⚠️ THE FRAME-0 CLAMP RUNS FOR AUDIO TOO, AND ONLY THAT. Audio has no frames to
            # snap to, which is why the whole-frame rule below skips it — but a negative
            # <in> is not a rounding question, it is a range that starts before the media
            # exists. build_command's audio branch already clamps it implicitly (a negative
            # `lead` cancels the -ss and shortens the -t), so the FILE was right: 1.600000 s
            # measured, clicks landing on source 0.0..1.6 exactly. The RECORD was not. It
            # kept source_in_seconds -0.4 and source_duration_seconds 2.0 for a 1.6 s file,
            # booked frames_trimmed 0, and named the clip in no warning — so the sheet's
            # "cut length s" and "frames" columns overstated it by the negative head while
            # the video cut beside it, with the identical shape, was clamped and reported.
            #
            # It is also what makes the out_time receipt in run_cut usable on this branch:
            # checked against the unclamped 2.0 s, a correct 1.6 s delivery FAILS.
            head = -c.source_in_seconds
            if fps <= 0 or head <= e or c.source_duration_seconds - head <= e:
                continue
            clamped.append(c.clip_name or Path(c.source_path).name)
            before = c.source_consumed_frames or consumed_frames(
                c.source_in_seconds, c.source_duration_seconds, fps)
            c.source_in_seconds = 0.0
            c.source_in_frames = 0
            c.source_duration_seconds = round(c.source_duration_seconds - head, 9)
            c.source_consumed_frames = consumed_frames(
                0.0, c.source_duration_seconds, fps)
            c.frames_trimmed = max(0, before - c.source_consumed_frames)
            n_touched += 1
            continue
        if fps <= 0 or c.media_kind == "still":
            continue
        in_f = c.source_in_seconds * fps
        out_f = (c.source_in_seconds + c.source_duration_seconds) * fps
        # ⚠️ START UP, END DOWN — the product decision, and it is the conservative one.
        # A fractional in-point sits inside a frame that the shot BEFORE also occupies, so
        # rounding the start DOWN hands that shared frame to this cut and the head shows
        # the previous scene. Rounding up gives up at most one frame and can never show
        # material from the neighbour. Same argument at the tail, mirrored.
        first = math.ceil(in_f - e)
        last = math.floor(out_f + e)            # a fractional end moves DOWN
        # ⚠️ NOTHING BEFORE FRAME 0. A clipitem whose media begins inside a head dissolve
        # carries a NEGATIVE <in>: Premiere shows a held first frame there, the file has no
        # frames there at all. build_command clamps the seek to 0.0 but used to keep the full
        # pin, so the delivery ran on past the timeline's out-point by exactly the clamped
        # count — measured against Premiere's own render of the same cut: 12 frames of footage
        # the edit never showed, on the one clip per timeline that has this shape (24 of 40
        # real exports). The range starts at the first frame that exists; the loss is on the
        # record in frames_trimmed and named in the warning below.
        if first < 0:
            clamped.append(c.clip_name or Path(c.source_path).name)
            first = 0
        n = last - first
        if n < 1:
            continue
        before = c.source_consumed_frames or consumed_frames(
            c.source_in_seconds, c.source_duration_seconds, fps)
        if n == before and abs(in_f - first) < e:
            continue                            # already whole frames; nothing to do
        c.source_in_seconds = first / fps
        c.source_duration_seconds = n / fps
        c.source_consumed_frames = n
        c.frames_trimmed = max(0, before - n)
        n_touched += 1
    if clamped and warnings is not None:
        warnings.append(
            f"{len(clamped)} cut(s) start before their media begins — the frames before "
            f"frame 0 were never shown and are not cut: " + ", ".join(clamped[:4])
            + (", …" if len(clamped) > 4 else ""))
    return n_touched


def cut_from_of(args) -> str:
    """Where this run's pixels come from: "render" or "source".

    One expression, in one place, because four callers now depend on the answer and three
    of them already computed it by hand: the manifest's settings block, the resume
    settings-drift comparison, and — since the filename fix — tc_range, which names a
    render-mode clip after its TIMELINE position. Two of those must agree exactly or
    --resume compares a name built one way against a name recorded the other.

    ⚠️ render_planned COUNTS, and reading only render_dir made the SCAN and the EXPORT name
    the same cut two different things. The panel sends --render-planned on the scan and
    --render-dir on the export — the render does not exist yet when the scan runs — so a
    render-mode scan named every clip on the SOURCE clock and the export renamed it on the
    TIMELINE clock. MEASURED on tests/PROMO_MASTER_v7.xml: 19 shared cuts, 16 of the 19
    filenames differ, e.g. 01_(05.71-07.71)_CAM_A.mp4 in the scan against
    01_(00.00-02.00)_CAM_A.mp4 in the export. The panel shows the scan's names, --resume
    matches on index_free() of the recorded name (16 of 19 misses, so a complete folder
    re-encodes), and a --pick file written from the scan names files the export never
    writes. Every other render-aware branch in this file already reads the pair — the
    probe skip, estimate_sizes, the nest default, the transition split, the --ext filter —
    so this is the one that disagreed with all of them.
    """
    return ("render" if (getattr(args, "render_planned", False)
                         or getattr(args, "render_dir", None)) else "source")


_INDEX_PREFIX_RE = re.compile(r"^\d+_(.*)$")


def index_free(name: str) -> str:
    """A filename with the numbering prefix assign_output_names hands out taken off.

    `03_(05.71-07.71)_CAM_A.mp4` -> `(05.71-07.71)_CAM_A.mp4`. The index comes from an
    enumerate() over the PICKED set, so it moves whenever a tick moves; everything after it
    is decided by the cut and the settings, which is exactly what --resume has to compare.
    """
    m = _INDEX_PREFIX_RE.match(name)
    return m.group(1) if m else name


def partial_name(name: str) -> str:
    """The name an encode wears while it is still being written.

    ⚠️ WRECKAGE MUST NOT WEAR A DELIVERY NAME. ffmpeg wrote straight to the delivered
    filename, so every way an encode can end badly — a non-zero exit, --timeout, a frame
    count short of the pin, the run being killed — left a half-written file sitting there
    under the name the editor is about to hand over. MEASURED: six 1080p cuts at
    --timeout 3 left six moov-less files of 15-16 MB each, and the folder is
    indistinguishable from a finished one until something opens them. Now the encode
    writes here and is os.replace()d onto the delivery name only after the frame check
    passes, so the delivery name appears complete or not at all.

    `01_(00.00-20.00)_big.mp4` -> `.01_(00.00-20.00)_big.part.mp4`. Three properties, each
    load-bearing:

    * a LEADING DOT. build_resume_index skips dotfiles on its filename route, the
      end-of-run stray advisory matches CUT_FILE_RE which needs a leading digit, and the
      panel's clashCount() skips `.` names too — so a partial left behind by a killed run
      is invisible to all three rather than adoptable by any of them.
    * the DELIVERY EXTENSION LAST. ffmpeg picks its muxer from the output suffix, and a
      name ending `.mp4.part` gets it no muxer at all.
    * the SAME DIRECTORY as the delivery. os.replace is only atomic within one filesystem,
      and an output folder is regularly on a different volume from any temp dir.
    """
    p = Path(name)
    return f".{p.stem}.part{p.suffix}"


# ⚠️ WHERE A FILE THIS RUN DID NOT PRODUCE GOES, INSTEAD OF STAYING UNDER A DELIVERY NAME.
# A clip that fails, goes missing or is refused this run used to leave the previous export's
# file under the exact name this run's manifest publishes: MEASURED on 3.88, a re-export with
# one camera's media half-synced printed `15 written, 4 failed` over a folder of 19
# finished-looking mp4, 4 of them from before, and nothing said which. Deleting them is not
# the engine's call — it is an editor's folder — so they are moved here, beside the clips,
# where Finder shows them and a person can put one back. One folder rather than renamed
# siblings: nothing in it matches CUT_FILE_RE, the resume index or the panel's list of
# clips, because none of those look into subfolders.
ASIDE_DIR = "_earlier_export"

# ⚠️ THE FOLDER'S OWN RECORD OF WHAT THIS ENGINE WROTE INTO IT, AND WHY manifest.json CANNOT
# BE THAT RECORD. The manifest describes ONE RUN, and three kinds of run replace it with a
# description of something else: a --pick run lists only the picked rows, a --manifest-only
# or --dry-run scan lists rows that were never encoded, and a killed run writes no manifest
# at all. --resume used to read its settings from whichever of those came last. MEASURED on
# 3.88: 19 clips at 100%, two re-exported at Half, then everything at Half with the tick on
# — no drift seen, `17 already there`, 14 full-size clips under a manifest saying 50%; and
# after a Cancel, `10 already there` at the wrong size because there was nothing at all to
# compare with.
#
# So every clip that passes its checks is recorded HERE the moment its name is claimed, with
# the identity and the settings it was made under, and --resume keeps a file only when this
# record vouches for exactly that file, that cut and these settings. Hidden, because it is
# the engine's bookkeeping and not a deliverable — the same reason partials are hidden — and
# small: file names, cut ids, byte counts (and, 3.93, each file's modification time), eight
# settings and (3.90) the sequence's name and
# Premiere id, no paths. The panel reads it too, to tell whose clips a version folder holds
# and in which mode (see ledger_sequence).
LEDGER_NAME = ".xmlcut-ledger.json"
LEDGER_SCHEMA = 1

# A partial this engine names (see partial_name): `.NN_….part.ext`, and the two mixes. Held
# to exactly those shapes so a sweep can never take a hidden file of the editor's.
_PARTIAL_RE = re.compile(r"^\.(?:\d+_.+|_timeline_audio|_track_A\d+)\.part\.[A-Za-z0-9]+$")

# How old a partial must be before a new run treats it as a dead run's wreckage. A live
# encode rewrites its partial continuously, so anything this still has stopped; the margin
# is for a second run started into the same folder while the first is still going, which
# nothing supported does but a sweep must not be able to punish.
STALE_PARTIAL_SECONDS = 120


def _manifest_record(out_dir: Path) -> tuple[dict, list]:
    """(settings, clips) from the folder's manifest.json, or ({}, []) for anything else.

    ⚠️ VALID JSON IS NOT A MANIFEST. The read caught OSError and ValueError, which covers a
    truncated or garbled file, and then called .get() on whatever json.loads returned — so a
    manifest.json that parsed as `[]`, `null`, `"x"`, `{"clips":[null]}` or a dict-valued
    `clips` ended the export in an AttributeError traceback before a single clip was cut
    (MEASURED on 3.88, all five). Some other tool's manifest.json in the chosen folder is
    enough. A record of the wrong shape is no record, which is what a garbled one already
    meant: every row is checked for being an object before anything reads it.
    """
    try:
        data = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, []
    if not isinstance(data, dict):
        return {}, []
    settings = data.get("settings")
    clips = data.get("clips")
    return (settings if isinstance(settings, dict) else {},
            [c for c in clips if isinstance(c, dict)] if isinstance(clips, list) else [])


def _manifest_sequence(out_dir: Path) -> dict:
    """The folder's manifest.json's sequence identity (ledger_sequence), or {}."""
    try:
        data = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return ledger_sequence(data.get("sequence")) if isinstance(data, dict) else {}


def _known_bytes(v) -> int:
    """A recorded byte count, or 0 when the row carries none that can be trusted."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and int(v) > 0:
        return int(v)
    return 0


def _known_mtime_ns(v) -> int:
    """A recorded st_mtime_ns, or 0 when the entry carries none (a ledger from before 3.93)."""
    if isinstance(v, int) and not isinstance(v, bool) and v > 0:
        return v
    return 0


def render_identity(cut) -> Optional[dict]:
    """{"bytes", "sha256"} of the render this cut is encoded from, or None when it has none.

    ⚠️ 3.93 AUDIT · THE RENDER IS PART OF WHAT A KEPT FILE MUST MATCH. cut_id describes the
    master clip (name, track, in/out, source, speed, reverse, nest) and RESUME_DRIFT_FIELDS
    the encode settings; neither says anything about what Premiere baked into a Timeline
    Render — a title fixed over the clip, a graphic, a grade, another track ticked in or out.
    MEASURED on 3.93: three clips delivered from red renders, one render rebuilt green, the
    same export with 'skip clips already there' -> `0 written … 3 already there`, the
    delivered clip still red, its manifest row naming the NEW render, and the panel then
    deleted that render as a clean run's. So every clip written from a render records the
    render's bytes here, and --resume keeps it only while this run's render is byte for byte
    the same file (plan_resume). The whole file is hashed — a size alone cannot see a title
    fixed at the same byte count — and a render re-made by Premiere carries a new timestamp
    in its metadata, so in practice a re-rendered range is re-cut: the keep is for a render
    that was reused (a Retry of a stopped run), which is the one case it is right for.

    Cached on the cut: computed once, OUTSIDE the folder step that records it, so the
    commit lock is never held while a large render is read.
    """
    p = getattr(cut, "render_path", "") or ""
    if not p:
        return None
    got = getattr(cut, "_render_identity", None)
    if got is not None:
        return got
    h = hashlib.sha256()
    n = 0
    try:
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
                n += len(chunk)
    except OSError:
        return None
    got = {"bytes": n, "sha256": h.hexdigest()}
    try:
        cut._render_identity = got
    except AttributeError:
        pass
    return got


def _render_record(v) -> Optional[dict]:
    """A ledger entry's render record as open() keeps it, or None for anything else."""
    if (isinstance(v, dict) and _known_bytes(v.get("bytes"))
            and isinstance(v.get("sha256"), str) and len(v["sha256"]) == 64):
        return {"bytes": int(v["bytes"]), "sha256": v["sha256"]}
    return None


def render_matches(recorded, cut) -> bool:
    """Is this run's render for `cut` the very file the recorded clip was made from?

    No record (a ledger from before 3.93, an entry seeded from a manifest, a clip written
    from source) is no proof, and no proof is a re-cut. The size is compared first so a
    render that changed length is never read in full just to be told so."""
    rec = _render_record(recorded)
    if rec is None:
        return False
    try:
        if os.path.getsize(cut.render_path) != rec["bytes"]:
            return False
    except (OSError, TypeError):
        return False
    now = render_identity(cut)
    return bool(now) and now["sha256"] == rec["sha256"] and now["bytes"] == rec["bytes"]


def ledger_sequence(v) -> dict:
    """A sequence identity as the ledger records it — {"name", "id"}, each only when it is a
    non-empty string (or an integer id) — or {} for anything else.

    ⚠️ 3.90 · WHICH SEQUENCE MADE EACH FILE, KEPT WHERE A RUN CANNOT ERASE IT. The panel
    refuses to export one sequence into a version folder another sequence delivered into, or
    in the other mode. It read both facts off manifest.json alone — and the manifest describes
    ONE RUN (see LEDGER_NAME): MEASURED on the 3.90 build, a Retry whose one clip failed again
    rewrote it as {missing_source: 1}, the folder still held all 19 delivered clips, and the
    4x5 twin was let in and replaced or moved every one of them. A Cancel on the first export
    (no manifest at all), a truncated or deleted manifest did the same. The ledger survives
    all of those, and already carries each file's cut_from; this is the other half."""
    if not isinstance(v, dict):
        return {}
    out = {}
    for k in ("name", "id"):
        x = v.get(k)
        if isinstance(x, bool) or not isinstance(x, (str, int)):
            continue
        x = str(x).strip()
        if x:
            out[k] = x
    return out


class FolderLedger:
    """What this engine has written into one output folder, file by file. See LEDGER_NAME.

    `files` maps a delivered filename to {"cut_id", "bytes", "mtime_ns", "settings"}.
    Written after every clip that is put in place, so a run that is killed halfway has
    already recorded the clips it finished — which is the case the manifest can never cover.
    """

    def __init__(self, out_dir: Path, files: dict, existed: bool, seeded: bool, now: dict,
                 had_record: bool = False, aside: Optional[dict] = None):
        self.out_dir = out_dir
        self.files = files
        # "_earlier_export/<name>" -> {"was", "cut_id", "why"}: where each file this engine
        # moved out of the delivery went. Written in the same step as the move, so after a
        # Cancel the record still says where a missing clip is — the build before simply
        # forgot every file it had moved, and a folder emptied by a Cancel had no record of
        # its twelve clips at all.
        self.aside = aside or {}
        self.existed = existed
        self.seeded = seeded
        # The folder carried SOME record of this engine's work (a ledger, or a manifest with
        # cut ids), whether or not any of it could be trusted. What decides that --resume
        # never falls back to bare filenames here — see build_resume_index.
        self.had_record = had_record or existed or seeded
        self.now = now
        # The sequence THIS run cuts, recorded with every file it writes (ledger_sequence).
        # Set by main() once the timeline is known; {} leaves the entries without one, which
        # is what an older version's entries look like too.
        self.sequence: dict = {}
        self._lock = threading.Lock()
        self._warned = False

    @classmethod
    def open(cls, out_dir: Path, args) -> "FolderLedger":
        """The folder's ledger — or, on a folder that has none yet, one seeded from its
        manifest, so the first run of this version keeps what an older one recorded.

        ⚠️ SEEDED BEFORE ANYTHING OVERWRITES THE MANIFEST, and that is why this runs for
        every kind of run, scans included: a --pick or --manifest-only run into a folder an
        older version wrote replaces the only record of the other clips' settings, and a
        seed taken after that is a seed of the wrong thing.
        """
        now = resume_fingerprint(args)
        files: dict = {}
        existed = False
        try:
            raw = json.loads((out_dir / LEDGER_NAME).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = None
        if isinstance(raw, dict) and isinstance(raw.get("files"), dict):
            existed = True
            aside = {}
            if isinstance(raw.get("set_aside"), dict):
                aside = {k: v for k, v in raw["set_aside"].items()
                         if isinstance(k, str) and k.startswith(ASIDE_DIR + "/")
                         and isinstance(v, dict)}
            for name, e in raw["files"].items():
                if (isinstance(name, str) and name and "/" not in name
                        and isinstance(e, dict) and isinstance(e.get("cut_id"), str)):
                    files[name] = {"cut_id": e["cut_id"],
                                   "bytes": _known_bytes(e.get("bytes")),
                                   "settings": (e["settings"] if isinstance(
                                       e.get("settings"), dict) else {})}
                    # Kept across runs, like the byte count: what vouches() compares (3.93).
                    _mt = _known_mtime_ns(e.get("mtime_ns"))
                    if _mt:
                        files[name]["mtime_ns"] = _mt
                    if e.get("seeded") is True:
                        files[name]["seeded"] = True
                    # Kept across runs: a run that does not re-make this file must not erase
                    # which sequence did (see ledger_sequence).
                    _seq = ledger_sequence(e.get("sequence"))
                    if _seq:
                        files[name]["sequence"] = _seq
                    # Kept too: a run that keeps this file must not erase which render it
                    # was made from, or the next --resume could never keep it (render_identity).
                    _rend = _render_record(e.get("render"))
                    if _rend:
                        files[name]["render"] = _rend
            return cls(out_dir, files, existed, False, now, aside=aside)
        settings, clips = _manifest_record(out_dir)
        # The sequence that manifest's run cut, for the entries seeded from it below.
        seq_was = _manifest_sequence(out_dir)
        # Only the fields that decide the pixels, and only those this manifest HAD: a field
        # an older version never recorded is absent, and absent is "not compared", which
        # is resume_settings_drift's rule for a folder written before the field existed.
        was = {k: settings[k] for k in RESUME_DRIFT_FIELDS if k in settings}
        # ⚠️ EXCEPT THE RENDER'S SOUND, which an older version made a real difference with
        # and never wrote down. From source the flag is a no-op, so absent can stay "not
        # compared"; from a render it decided whether the clips carry audio, and a folder
        # that cannot say which is re-cut once rather than kept silent (or loud) against
        # this run's choice — the F15 defect again, on the first run after the upgrade.
        if settings.get("cut_from") == "render" and "render_audio" not in settings:
            was["render_audio"] = "unrecorded"
        for c in clips:
            cid, out = str(c.get("cut_id") or ""), str(c.get("output_file") or "")
            # ⚠️ `ok` ONLY — the rows that manifest's own run ENCODED, under the settings its
            # block states. A `skipped_existing` row is an older version's --resume vouching
            # for a file by the very rules this replaces: MEASURED on 3.88 it pointed the
            # reversed shot at the forward clip's file and kept full-size clips under a Half
            # manifest. Seeding those would carry both defects across the upgrade inside the
            # new record. Not seeded means re-cut once, which costs seconds.
            if (not cid or not out or "/" in out
                    or str(c.get("status") or "") != "ok"):
                continue
            try:
                size = (out_dir / out).stat().st_size
            except OSError:
                continue
            want = _known_bytes(c.get("output_bytes"))
            if size <= 0 or (want and size != want):
                continue
            # `seeded` marks an entry this engine did not write itself: it is enough to KEEP
            # the file (that manifest's own run encoded it), and not enough to DELETE it —
            # see vouches().
            files[out] = {"cut_id": cid, "bytes": size, "settings": dict(was),
                          "seeded": True}
            if seq_was:
                files[out]["sequence"] = dict(seq_was)
        # ⚠️ A MANIFEST WITH IDS IS A RECORD EVEN WHEN NOTHING IN IT COULD BE SEEDED. Without
        # this, a folder whose manifest held only `skipped_existing` rows — an older
        # version's resume that kept everything — seeded nothing, looked record-less, and
        # the bare-filename route kept every file the line above had just declined to vouch
        # for.
        had = bool(files) or any(str(c.get("cut_id") or "") for c in clips)
        return cls(out_dir, files, False, bool(files), now, had_record=had)

    def record(self, name: str, cut_id: str, nbytes: int,
               render: Optional[dict] = None) -> None:
        if not name or not cut_id:
            return
        # ⚠️ 3.93 AUDIT · THE FILE'S OWN MODIFICATION TIME, READ THE MOMENT IT IS IN PLACE, is
        # what lets vouches() tell this tool's file from a hand-replaced one of the same byte
        # count (see there). Read here, after the rename, and only kept when the size read
        # with it is the size recorded: a stat that disagrees is no proof, so no stamp.
        try:
            _st = (self.out_dir / name).stat()
            _mt = _st.st_mtime_ns if _st.st_size == int(nbytes or 0) else 0
        except OSError:
            _mt = 0
        with self._lock:
            self.files[name] = {"cut_id": cut_id, "bytes": int(nbytes or 0),
                                "settings": dict(self.now)}
            if _mt > 0:
                self.files[name]["mtime_ns"] = _mt
            if self.sequence:
                self.files[name]["sequence"] = dict(self.sequence)
            # The render this clip was encoded from, when it was (see render_identity).
            _rend = _render_record(render)
            if _rend:
                self.files[name]["render"] = _rend
            self._save_locked()

    def vouches(self, name: str, cut_id: str) -> bool:
        """Does this record PROVE that `name` is the file this engine wrote for `cut_id`,
        at this run's settings, and that it is still the bytes it wrote?

        ⚠️ THE ONLY GATE ON A DELETE. The one file the engine deletes is a clip's
        old-numbered copy once the clip's re-encode under its new number has landed (see
        FolderTidy._dispose), and only this may say yes to that. A seeded entry says no: it
        was inferred from an older manifest, not written here, and an inference is enough
        to keep a file and never enough to destroy one. Anything this says no to is moved
        aside instead.

        ⚠️ 3.93 AUDIT · THE SIZE ALONE WAS THE WHOLE PROOF, so a file an editor replaced by
        hand with one of the SAME byte count — a re-export of the fix at the same length, a
        file copied in over it — was deleted as "the old-numbered copy this tool wrote". The
        entry now also holds the file's st_mtime_ns, read when this tool put it in place
        (record), and both must still match. Metadata only: reading the clip back to hash it
        would download every renumbered file of a Drive folder just to decide a delete. An
        in-place rewrite changes the time; a copy brought in over the name carries the time
        of the file it came from. NOT the inode, though the time alone cannot see a
        replacement stamped with this file's exact time to the nanosecond: a folder that is
        copied, restored or synced (the suite's own fixtures copy folders) gives every file a
        new inode with the same bytes and time, and proof that fails on every copy of a folder
        is no proof worth having. An entry with no time — a ledger an engine before 3.93
        wrote — proves nothing, so its file is moved aside, never deleted; the same for a
        Drive round trip that rewrote the time. Both are the safe direction: a copy left in
        ASIDE_DIR costs disk, a wrong delete costs the editor's work.
        """
        with self._lock:
            e = self.files.get(name)
            if (not e or e.get("seeded") or e.get("cut_id") != cut_id
                    or not e.get("bytes") or not _known_mtime_ns(e.get("mtime_ns"))
                    or _drift_between(e.get("settings") or {}, self.now)):
                return False
            nbytes, mtime_ns = e["bytes"], e["mtime_ns"]
        try:
            st = (self.out_dir / name).stat()
        except OSError:
            return False
        return st.st_size == nbytes and st.st_mtime_ns == mtime_ns

    def forget(self, name: str) -> None:
        with self._lock:
            if self.files.pop(name, None) is not None:
                self._save_locked()

    def note_aside(self, name: str, where: str, why: str) -> None:
        """`name` was just moved to `where`: no longer a delivered file, and recorded as
        moved rather than forgotten."""
        with self._lock:
            e = self.files.pop(name, None) or {}
            self.aside[where] = {"was": name, "cut_id": e.get("cut_id"), "why": why}
            self._save_locked()

    def save(self) -> None:
        with self._lock:
            self._save_locked()

    def _save_locked(self) -> None:
        # A file that is no longer there is no longer vouched for. Pruned here rather than
        # trusted later, so the record never grows a tail of names nothing will match.
        self.files = {n: e for n, e in self.files.items() if (self.out_dir / n).is_file()}
        self.aside = {w: e for w, e in self.aside.items() if (self.out_dir / w).is_file()}
        if not self.files and not self.aside and not self.existed:
            return
        doc = {"schema": LEDGER_SCHEMA, "tool": f"{NAME} {VERSION}",
               "note": "What this tool wrote into this folder, and from which sequence, "
                       "for 'skip clips already there' and for the panel's check of whose "
                       "clips these are. If it is deleted, the next export keeps only what "
                       "the last manifest.json says it encoded (and re-cuts the rest), and "
                       "the panel has only manifest.json to tell whose the clips are.",
               "files": self.files, "set_aside": self.aside}
        tmp = self.out_dir / partial_name(LEDGER_NAME)
        try:
            tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
            os.replace(str(tmp), str(self.out_dir / LEDGER_NAME))
            self.existed = True
        except OSError as e:
            # ⚠️ NEVER FATAL. The ledger is what lets a LATER run skip work; failing to
            # write it costs that run a re-encode and nothing else, so it must not be able
            # to fail a clip that is already on disk and verified.
            try:
                tmp.unlink()
            except OSError:
                pass
            if not self._warned:
                self._warned = True
                say(f"  (could not update this folder's record of its clips: {e} — a "
                    f"later 'skip clips already there' will re-cut rather than keep them)")


def build_resume_index(out_dir: Path, ledger: Optional[FolderLedger] = None) -> dict:
    """What the output folder ALREADY holds, and what vouches for each file.

    ⚠️ WHY THIS EXISTS. `--resume` used to be `out_path.exists()`, and `out_path` carries the
    index that `assign_output_names` hands out with `enumerate()` — AFTER every filter. So a
    second run with a different selection renumbers everything, last run's `03_…` is this
    run's `07_…`, and the check misses. Measured on a real folder: it matched 1 of 8 clips,
    which made the panel's "skip clips already there" tick a control that quietly did almost
    nothing.

    Two sources, and only ever one of them:

    * the folder's LEDGER (seeded from its manifest when it has none yet): file -> the
      cut_id and the settings it was made under. cut_id is a content hash of the clip, so
      it survives renumbering, a re-sort and the cross-dissolve split.
    * the filename with its index prefix stripped, ONLY for a folder that holds no record
      at all — one an old version wrote and then lost its manifest from.

    ⚠️ NEVER BOTH. The filename route used to run beside the record for every cut the record
    did not name, and it asked only whether exactly one file on disk wore that index-free
    name — not whom the record had given it to. MEASURED on the suite's own fixture:
    Cutaway_fast (forward, 200%) and Reverse_shot (reversed, 100%) are both
    `(06.67-08.33)_CAM_B.mp4`; re-export the first alone, then everything with the tick on,
    and the reversed shot was never written — `[1/21] HAVE 05_…` twice, both rows pointing
    at the forward clip, frame_exact true on each. Two cameras that both name their files
    C0001.MP4 did the same, delivering card B as card A. A file the record does not vouch
    for is re-encoded: that costs seconds, and the other way ships the wrong picture.
    """
    records = dict(ledger.files) if ledger is not None else {}
    recorded = bool(ledger is not None
                    and (ledger.had_record or ledger.existed or ledger.files))
    suffix_count: dict[str, int] = {}
    # The one file that wears each index-free name, for the unambiguous legacy case: a skip
    # has to be able to adopt the name that satisfied it.
    suffix_name: dict[str, str] = {}
    # What the folder's OWN manifest recorded as `failed`, held as INDEX-FREE names, plus
    # every recorded file whose bytes no longer match its record. Kept out of both routes
    # and counted for the console line, so the re-cut is explained rather than just
    # happening.
    #
    # ⚠️ INDEX-FREE, NOT THE EXACT NAME, and the difference is a route wreckage still got
    # through. A `--pick-renumber` run numbers its rows from 01 — so a Retry of a failed
    # clip recorded it as `01_(04.00-05.00)_CAM_B.mp4` while the wreckage on disk still wore
    # `03_(04.00-05.00)_CAM_B.mp4`, and the next full --resume adopted the 03_ file. Being
    # wrong here costs one re-encode; being wrong the other way ships the file.
    wrecked: set[str] = set()
    try:
        names = [p for p in out_dir.iterdir() if p.is_file()]
    except OSError:
        return {"records": {}, "recorded": recorded, "suffix": {}, "suffix_name": {},
                "wrecked": set(), "how": "unreadable", "files": 0, "failed": 0}

    # ⚠️ THE RECORDED STATUS, NOT JUST THE BYTES. `failed` is the only status that can follow
    # an ffmpeg invocation, so it is the only one whose name can be wearing wreckage — an
    # older version wrote straight to the delivery name, and MEASURED on six 1080p cuts at
    # --timeout 3 all six moov-less files came back `HAVE` on the next --resume. The rest
    # (missing_source, unsupported, no_render, render_mismatch, no_audio, dry_run) never
    # reached the encoder; naming those as wreckage too would make a --dry-run into a
    # finished folder re-encode all of it.
    for c in _manifest_record(out_dir)[1]:
        out = str(c.get("output_file") or "")
        if out and str(c.get("status") or "") == "failed":
            wrecked.add(index_free(out))
    # ⚠️ AND THE FILE HAS TO STILL BE THE ONE ITS RECORD DESCRIBES. A clip from a finished
    # run, truncated on disk to 20,000 bytes (ffprobe: `Invalid NAL unit size`, `partial
    # file`), was reported HAVE and republished as skipped_existing with frame_exact true,
    # because its row said ok and its size was merely non-zero. Truncated copies,
    # interrupted syncs to a shared drive and half-restored backups all land here. The
    # recorded size is free to compare and catches all of them; a record with no size (an
    # older schema) has nothing to compare and is admitted as before.
    for name, e in list(records.items()):
        try:
            size = (out_dir / name).stat().st_size
        except OSError:
            records.pop(name)
            continue
        if size <= 0 or (e.get("bytes") and size != e["bytes"]):
            wrecked.add(index_free(name))
            records.pop(name)

    files = failed_files = 0
    for f in names:
        if f.name.startswith(".") or f.suffix.lower() in (".csv", ".json", ".mp3"):
            continue
        if f.stat().st_size <= 0:
            continue
        # Keeping a wrecked name out of the COUNT as well as out of the index is the point —
        # leaving it in would also make the one good file sharing its index-free name look
        # ambiguous on the legacy route.
        if index_free(f.name) in wrecked:
            failed_files += 1
            continue
        # ⚠️ FILES, NOT NAMES. This used to be len(suffix_count) — the number of distinct
        # index-free names — so a folder holding two cuts of one source range reported one
        # file fewer than it held (MEASURED: `18 file(s) already in the folder` over 19).
        files += 1
        suffix_count[index_free(f.name)] = suffix_count.get(index_free(f.name), 0) + 1
        suffix_name.setdefault(index_free(f.name), f.name)
    how = ("ledger" if (ledger is not None and ledger.existed and records)
           else "manifest" if records
           else "filename" if (suffix_count and not recorded) else "nothing")
    return {"records": records, "recorded": recorded, "suffix": suffix_count,
            "suffix_name": suffix_name, "wrecked": wrecked, "how": how,
            "files": files, "failed": failed_files}


# What a kept file must have been made with, beyond its identity and its name. Deliberately
# NOT container or whole_frames: those two move the FILENAME, so the recorded-name comparison
# already catches them clip by clip. These change the delivered pixels, bytes or streams
# while leaving every filename identical, which is the half a name comparison cannot see —
# --scale 50 --resume kept a folder of full-size clips and called them "already there".
#
# ⚠️ render_audio IS ONE OF THEM, and it was missing from both this list and the manifest.
# MEASURED on 3.88: a silent Timeline Render export, then the same export with a track
# ticked to be heard (the panel sends --render-audio for that, and --resume from a standing
# tick) printed `19 already there` and delivered 19 files with no audio stream — and the
# reverse kept the sound the editor had just muted.
RESUME_DRIFT_FIELDS = ("crf", "bitrate", "vcodec", "x264_preset", "scale_percent",
                       "output_fps", "speed", "cut_from", "render_audio")


def resume_fingerprint(args) -> dict:
    """This run's value for every field in RESUME_DRIFT_FIELDS — what a kept file must match.

    ONE computation, used for the comparison, for the record of every clip written, and for
    the manifest's settings block, so the three cannot describe a run differently.
    """
    cut_from = cut_from_of(args)
    return {
        "crf": (None if parse_bitrate(getattr(args, "bitrate", None) or "")
                else crf_of(args)),
        "bitrate": (getattr(args, "bitrate", None) or None),
        "vcodec": vcodec_of(args),
        "x264_preset": getattr(args, "x264_preset", None) or X264_PRESET,
        "scale_percent": scale_of(args),
        "output_fps": (float(args.fps) if getattr(args, "fps", None) else None),
        "speed": getattr(args, "speed", "native"),
        "cut_from": cut_from,
        # Only a render carries the timeline's sound; from source the flag changes nothing,
        # so it is recorded as False there rather than re-cutting a folder for a no-op.
        "render_audio": bool(getattr(args, "render_audio", False)) and cut_from == "render",
    }


def _drift_between(previous: dict, now: dict) -> list[str]:
    out = []
    for k in RESUME_DRIFT_FIELDS:
        if k not in previous:
            continue                      # a folder written before the field existed
        was, is_ = previous.get(k), now.get(k)
        if (isinstance(was, (int, float)) and not isinstance(was, bool)
                and isinstance(is_, (int, float)) and not isinstance(is_, bool)):
            if abs(float(was) - float(is_)) > 1e-9:
                out.append(f"{k} {was} -> {is_}")
        elif was != is_:
            out.append(f"{k} {was!r} -> {is_!r}")
    return out


def resume_settings_drift(previous: dict, args) -> list[str]:
    """Which encode settings this run does not share with a record it is resuming from.

    Acted on by re-cutting, rather than by refusing the run: the panel lets someone
    re-export into the same folder at a different crf with the tick on, and a hard stop
    turns a working flow into a dead end. Silently keeping the old pixels is the one option
    that is not available.
    """
    if not previous:
        return []
    return _drift_between(previous, resume_fingerprint(args))


def _number_of(name: str) -> int:
    m = re.match(r"^(\d+)_", name or "")
    return int(m.group(1)) if m else 0


def plan_resume(cuts: list, idx: dict, args) -> dict:
    """Decide, BEFORE anything is encoded, which cut keeps which file already in the folder.

    Decided here for the whole run rather than inside run_cut one clip at a time, because
    every defect this replaces was a question about two cuts at once: two cuts adopting one
    file, or a kept file wearing the number this run gives a different clip. Returns the
    counts the --resume line reports and sets args.resume_plan = {cut_id: filename}. It
    touches nothing on disk; FolderTidy does, and only on a real export.

    ⚠️ A FILE IS KEPT ONLY UNDER THE EXACT NAME THIS RUN GIVES ITS CLIP — the number
    included. A skip used to adopt whatever number its file already wore, which is right
    while the timeline stands still and wrong once it moves: drop a clip into a gap and it
    takes the number the next clip had, which that clip's kept file still wears. MEASURED
    on 3.88: two `02_` files in the folder, the last number missing, and a manifest whose
    index column disagreed with every name after the edit. A first fix RENAMED the kept
    file on a collision; the product owner ruled that out (23 Sep): a clip whose number
    changed is re-encoded under the new one, and its old-numbered file is deleted only when
    the folder's ledger proves this tool wrote it for that same cut — see
    FolderTidy, which does both. So a number mismatch here is simply "not kept".
    """
    now = resume_fingerprint(args)
    records = idx.get("records") or {}
    by_id: dict[str, list] = {}
    for name, e in records.items():
        by_id.setdefault(e["cut_id"], []).append(name)
    wrecked = idx.get("wrecked") or set()
    legacy = not idx.get("recorded")
    want = collections.Counter(index_free(c.output_file) for c in cuts if c.output_file)
    adopt: dict[int, str] = {}                 # id(cut) -> the file it keeps
    claimed: set[str] = set()
    drift: list[str] = []
    n_drift = 0
    n_render = 0                               # kept files whose render is not this run's
    ambiguous: set[str] = set()
    renumbered: list = []                      # (the file's name, this run's name)
    legacy_stale: list = []                    # unrecorded files that match by name only
    for c in cuts:
        # ⚠️ A CUT THIS RUN IS REPAIRING IS NEVER "ALREADY THERE" — the file in the folder
        # is the one-frame-shifted clip the repair exists to replace, and no setting
        # changed for the comparison below to see.
        if not c.output_file or not c.cut_id or c.render_head_trim > 0:
            continue
        key = index_free(c.output_file)
        if key in wrecked:
            continue
        if not legacy:
            # ⚠️ THE ID IS NOT ENOUGH ON ITS OWN: cut_id holds nothing about the
            # deliverable, so it matches across a change of --container or of whole frames,
            # both of which rename the file. MEASURED: `--container mov --resume` into a
            # folder of .mp4 printed `23 already there` and wrote ZERO files. The index-free
            # NAME must match as well.
            cands = sorted((n for n in by_id.get(c.cut_id, ()) if index_free(n) == key),
                           key=lambda n: (n != c.output_file, n))
            if not cands:
                continue
            d = _drift_between(records[cands[0]].get("settings") or {}, now)
            if d:
                n_drift += 1
                drift += [x for x in d if x not in drift]
                continue
            # ⚠️ 3.93 AUDIT · AND A CLIP CUT FROM A RENDER IS KEPT ONLY OVER THE SAME RENDER.
            # Nothing above can see what Premiere baked into it; see render_identity.
            if c.render_path and not render_matches(records[cands[0]].get("render"), c):
                n_render += 1
                continue
            name = cands[0]
        else:
            # A render's content cannot be vouched for by a folder with no record at all.
            if c.render_path:
                n_render += 1
                continue
            # The folder holds no record, so the name is all there is. One file with it AND
            # one cut of this run wanting it, or nothing: a second cut wanting the same
            # index-free name is the Cutaway/Reverse pair again, on a folder with no ids.
            if idx["suffix"].get(key) == 1 and want[key] == 1:
                name = idx["suffix_name"][key]
            else:
                if idx["suffix"].get(key):
                    ambiguous.add(key)
                continue
        if name != c.output_file:
            renumbered.append((name, c.output_file))
            if legacy:
                legacy_stale.append(name)
            continue
        if name in claimed:
            continue
        claimed.add(name)
        adopt[id(c)] = name
    args.resume_plan = {c.cut_id: adopt[id(c)] for c in cuts if id(c) in adopt}
    return {"matched": len(adopt), "legacy": legacy, "drift": drift, "n_drift": n_drift,
            "n_render": n_render,
            "ambiguous": len(ambiguous), "renumbered": renumbered,
            "legacy_stale": legacy_stale}


def move_aside(outdir: Path, name: str) -> Optional[str]:
    """Move `name` into ASIDE_DIR, never over anything already there. Returns where it went,
    relative to outdir, or None when it could not be moved (it is then still in place)."""
    src = outdir / name
    aside = outdir / ASIDE_DIR
    try:
        aside.mkdir(exist_ok=True)
        p = Path(name)
        dst = aside / name
        n = 2
        while dst.exists():
            dst = aside / f"{p.stem} ({n}){p.suffix}"
            n += 1
        os.rename(str(src), str(dst))
    except OSError:
        return None
    return f"{ASIDE_DIR}/{dst.name}"


# ⚠️ 3.93 AUDIT · ONE RUN AT A TIME IN ONE FOLDER. Nothing locked a delivery folder, and two
# exports into one — the panel and a terminal or the browser GUI beside it — destroyed each
# other: both encode a cut to the same hidden partial name and each unlinks the other's at
# its start, os.replace() publishes the other run's half-written file, and set_aside_leftovers
# then moves the other run's delivered clips aside "from an EARLIER run". MEASURED on 3.93,
# 12 cuts, the second run started 0.2-1.0 s after the first: both exit 0, the folder left
# with 0-6 of 12 clips, moov-less files published as written, and a manifest calling `ok`
# clips that sit in _earlier_export/. So an export holds this file in the folder for as long
# as it runs (take_run_lock), and a second run on THIS Mac is refused before it touches
# anything. A lock left by a run that died (SIGKILL, a crash) is recognised by its process
# being gone and is taken over. A lock written by ANOTHER Mac (a team drive syncs it) cannot
# be checked from here, so it is said on a `!!` line and taken over rather than blocking the
# folder for good — that case (two Macs on one Drive folder) was not measured.
RUN_LOCK_NAME = ".xmlcut-running"
_RUN_LOCKS: list = []


def _run_is_alive(pid) -> bool:
    """Is process `pid` on this Mac still running, and still one of this tool's?"""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    # A pid is reused: a dead run's number can belong to something else by now.
    try:
        r = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True,
                           text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            return "xmlcut" in r.stdout
        return r.returncode != 1
    except (OSError, subprocess.SubprocessError):
        return True


def take_run_lock(outdir: Path) -> Optional[str]:
    """Hold `outdir` for this run. None when held (or when no lock can be made at all, which
    is not worth failing an export over); otherwise the sentence refusing the run."""
    p = outdir / RUN_LOCK_NAME
    me = {"pid": os.getpid(), "host": socket.gethostname(),
          "started": time.strftime("%Y-%m-%d %H:%M:%S"), "tool": f"{NAME} {VERSION}"}
    for _ in range(3):
        try:
            fd = os.open(str(p), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            try:
                other = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                other = {}
            if not isinstance(other, dict):
                other = {}
            host, pid = str(other.get("host") or ""), other.get("pid")
            if host == me["host"] and pid != me["pid"] and _run_is_alive(pid):
                return (f"another export is already writing into {outdir} (process {pid}, "
                        f"started {other.get('started') or 'at an unknown time'}). Two runs "
                        f"in one folder overwrite each other's clips, so this one did not "
                        f"start — wait for that one to finish, or stop it, and export again")
            if host and host != me["host"]:
                say(f"  !! this folder was being exported into from another Mac ({host}, "
                    f"started {other.get('started') or 'at an unknown time'}); that run "
                    f"cannot be checked from here — if it is still going, the two will "
                    f"overwrite each other's clips")
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                return None
            continue
        except OSError:
            return None
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(me, f)
        except OSError:
            pass
        _RUN_LOCKS.append((p, me["pid"]))
        return None
    return None


def release_run_locks() -> None:
    """Remove this process's run locks — only ever one this process wrote."""
    for p, pid in list(_RUN_LOCKS):
        try:
            other = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(other, dict) and other.get("pid") == pid:
                p.unlink()
        except (OSError, ValueError):
            pass
    _RUN_LOCKS.clear()


def sweep_stale_partials(outdir: Path) -> list[str]:
    """Remove the partials a run that could not clean up after itself left behind.

    ⚠️ ONLY THIS ENGINE'S OWN WRECKAGE, AND ONLY WHEN IT HAS STOPPED. A Cancel is cleaned
    up by the stop handler (see _stop_on_signal); this is for the kills nothing can catch —
    SIGKILL, a crash, a power cut — whose partials were otherwise removed only if a later
    run re-encoded that exact cut. MEASURED on 3.88: eight hidden `.NN_….part.mp4`, 60 MB,
    seven of them moov-less, in a folder that looked empty in Finder and travelled with it
    when it was zipped. The name shape is _PARTIAL_RE and nothing wider, and a partial
    touched in the last STALE_PARTIAL_SECONDS is left alone.
    """
    gone = []
    cutoff = time.time() - STALE_PARTIAL_SECONDS
    try:
        entries = list(outdir.iterdir())
    except OSError:
        return gone
    for f in entries:
        try:
            if (_PARTIAL_RE.match(f.name) and f.is_file()
                    and f.stat().st_mtime < cutoff):
                f.unlink()
                gone.append(f.name)
        except OSError:
            pass
    return gone


def _delivery_exists(cut: Cut, outdir: Path) -> bool:
    """Is a file from an earlier run still sitting at this cut's delivery name?"""
    try:
        return bool(cut.output_file) and (outdir / cut.output_file).is_file()
    except OSError:
        return False


# The statuses under which THIS run put nothing at a cut's delivery name.
NOT_PRODUCED = ("failed", "missing_source", "unsupported", "no_render", "render_mismatch",
                "no_audio")


def set_aside_leftovers(tl, args) -> list:
    """Move every earlier run's file out from under a name this run did not produce.

    ⚠️ A REFUSAL, A FAILURE OR A MISSING SOURCE DOES NOT EMPTY THE FOLDER. The previous
    export's file stays under the very name this run's manifest publishes, and an editor
    opening the folder, or a job reading the manifest, finds a file that looks delivered
    and is not this run's. This used to be SAID for render_mismatch alone — and MEASURED on
    3.88, a range Premiere did not produce, a render one frame short and a source that
    could not be read all left the old file there with nothing said. Moved, not deleted:
    it may be the only copy of good work, and putting it back is one drag.

    ⚠️ EXCEPT A FILE ANOTHER CLIP OF THIS RUN STILL NEEDS. When two clips trade names, the
    name this clip was refused under can hold the other clip's old-numbered file, whose own
    re-encode did not land either; that file is the other clip's only copy, and rule 2 keeps
    it where it is (see FolderTidy). It is named on a `!!` line instead of being moved.

    Moves, ledger notes and the `!!` line happen in ONE uninterrupted() step, so a Cancel
    lands before all of it or after all of it — never between a move and its warning.
    Returns the moved (cut, where) pairs, where None means it could not be moved. Never
    raises: this runs after every clip is on disk, and an advisory may not fail the export
    it is advising about.
    """
    moved = []
    try:
        mine = {c.output_file for c in tl.cuts
                if c.status in ("ok", "skipped_existing") and c.output_file}
        led = getattr(args, "ledger", None)
        st = getattr(args, "tidy", None)
        needed = []
        with uninterrupted():
            for c in tl.cuts:
                if (c.status not in NOT_PRODUCED or not c.output_file
                        or c.output_file in mine or not _delivery_exists(c, args.out)):
                    continue
                c.stale_delivery = True
                holder = st.still_needed_by(c.output_file) if st is not None else None
                if holder is not None:
                    needed.append((c, holder))
                    continue
                where = move_aside(args.out, c.output_file)
                if where and led is not None:
                    led.note_aside(c.output_file, where, f"{c.status} this run")
                moved.append((c, where))
            _moved = [(c, w) for c, w in moved if w]
            _stuck = [c for c, w in moved if not w]
            if _moved:
                _warn_now(tl.warnings,
                          f"{len(_moved)} file(s) from an EARLIER run were under names this "
                          f"run did not produce (failed, missing or refused below) — moved "
                          f"to {ASIDE_DIR}/, not deleted, so nothing in the folder looks "
                          f"delivered that is not: "
                          + ", ".join(f"{c.clip_name} [{c.output_file}]" for c, _ in _moved[:6])
                          + (", …" if len(_moved) > 6 else ""))
            if _stuck:
                _warn_now(tl.warnings,
                          f"{len(_stuck)} refused clip(s) still have a file from an EARLIER "
                          f"run sitting under the name this run's manifest gives them, and it "
                          f"could not be moved aside. It was not written by this run and was "
                          f"not checked by it — delete it, or re-render the range and cut "
                          f"again: "
                          + ", ".join(f"{c.clip_name} [{c.output_file}]" for c in _stuck[:6])
                          + (", …" if len(_stuck) > 6 else ""))
            if needed:
                _warn_now(tl.warnings,
                          f"{len(needed)} clip(s) were not produced this run, and the file "
                          f"under the name each would have taken is ANOTHER clip's earlier "
                          f"file, still its only copy because that clip was not re-encoded "
                          f"either — left in place, not this clip's: "
                          + ", ".join(f"{c.clip_name} [{c.output_file} is {h.clip_name}'s]"
                                      for c, h in needed[:6])
                          + (", …" if len(needed) > 6 else ""))
    except Exception as e:                                      # noqa: BLE001
        print(f"  (could not check for earlier files under this run's names: {e})")
    return moved


def _warn_now(warnings: list, text: str) -> None:
    """A `!!` warning printed the moment its cause happens, and kept for the manifest."""
    warnings.append(text)
    say(f"\n  !! {text}")


class FolderTidy:
    """The product owner's two rules (23 Sep) for a folder this run writes into, applied to
    what the folder's ledger knows — and applied IN THE ORDER A CANCEL CAN SURVIVE.

    1. A file this run cannot reuse is MOVED into ASIDE_DIR, never deleted, and the run says
       which and why on a `!!` line.
    2. A clip still correct but whose NUMBER changed is re-encoded under the new number and
       its old-numbered file DELETED — only when FolderLedger.vouches() proves this tool
       wrote that file for that same cut at these settings. Anything it cannot prove falls
       under rule 1.

    ⚠️ WHY THE ORDER IS THE WHOLE FIX. The build before moved EVERY held and stale file into
    ASIDE_DIR before the first encode and printed the `!!` lines after the pool, which a
    Cancel never reaches. MEASURED on it: a complete 12-clip folder, the head clip lifted so
    every later clip renumbers, --resume, the panel's Cancel 0.3 s into the encodes —
    rc -15, zero `!!` lines, the delivery EMPTY, all 12 files aside, and the ledger had
    forgotten every one. So now:

    * A file that is only RENUMBERED stays exactly where it is, in the ledger, until its
      clip's re-encode under the new number has LANDED; only then is it deleted (rule 2) or
      moved aside (rule 1, when the ledger cannot vouch). A clip that fails, is refused,
      goes offline, is cancelled or never runs leaves it untouched.
    * Only a file of a clip the edit no longer has is moved before the encodes — it can
      never be needed again — with its `!!` line printed and the ledger noting where it
      went in the same uninterrupted() step.
    * A clip whose new name is still occupied by ANOTHER clip's not-yet-replaced file keeps
      its finished encode under its hidden partial name (it stays registered, so a Cancel
      removes it) and is swapped in only when that other clip lands. Two clips of one
      source range trade names on an insert ahead of them; a chain of them resolves from
      the free end, and a cycle lands in one step.

    Every step that changes a delivery name runs inside uninterrupted(), so the stop
    handler waits for it: a Cancel at any moment leaves each still-valid clip either under
    a number the ledger knows or replaced by its re-encode, and the log and the ledger say
    what the folder holds.
    """

    def __init__(self, tl, args):
        self.out: Path = args.out
        self.led = getattr(args, "ledger", None)
        self.warnings: list = tl.warnings
        self.by_id = {c.cut_id: c for c in tl.cuts if c.cut_id and c.output_file}
        # cut id -> [(old name, renumbered only, why)]: that clip's earlier copies, settled
        # when it lands and left alone when it does not.
        self.superseded: dict = {}
        # old name -> the cut id whose superseded copy it is.
        self.occupant: dict = {}
        # name -> why: a file of a clip on the timeline that this run did not select, sitting
        # at a name a clip of this run writes. Moved aside only when that clip lands.
        self.displace: dict = {}
        self.landed: set = set()
        self.done: set = set()
        # cut id -> (cut, partial, delivery path, the cut id it waits on)
        self.parked: dict = {}
        self.parked_ids: set = set()
        # Parked cuts settled by ANOTHER cut's thread, for the main loop to report.
        self.late: list = []
        self.deleted: list = []                     # (old name, new name)
        self.not_redone: list = []                  # (old name, cut)

    # ------------------------------------------------------------------ before the encodes
    def plan(self, args) -> None:
        led = self.led
        if led is None:
            return
        out = self.out
        plan = (getattr(args, "resume_plan", None) or {}) if getattr(args, "resume", False) \
            else {}
        kept = set(plan.values())
        target_of = {c.output_file: c for c in self.by_id.values()
                     if plan.get(c.cut_id) != c.output_file}
        timeline_ids = set(getattr(args, "timeline_cut_ids", None) or ())
        on_timeline = timeline_ids | set(self.by_id)
        # ⚠️ 3.93 AUDIT · A FILE THIS RUN IS ABOUT TO REPLACE UNDER ANOTHER NUMBER IS NOT A
        # CLIP THE EDIT NO LONGER HAS. cut_id carries the timeline in/out and the absolute
        # source path, so a ripple insert or delete ahead of a clip — or the same folder
        # exported from another Mac, whose media sits under another /Users/… — gives every
        # later clip a new id, and every one of their files used to be moved aside BEFORE the
        # first encode as "no clip on this timeline matches it any more". MEASURED on 3.93: a
        # head insert into a 10-clip folder, the panel's Cancel after the first new clip
        # landed -> rc -15, the delivery holding 2 clips, 10 aside. Each of those files wears
        # the index-free name (source range and source file, or timeline range in Timeline
        # Render) of exactly one clip of this run, which writes it under a new number. Such
        # a file now waits for that clip to LAND, like any renumbered file, and is then moved
        # aside (rule 1 — the ledger cannot vouch for it under the new id, so it is never
        # deleted); if that clip never lands it stays where it is. Only a name two clips of
        # this run share, or none, is still moved up front.
        _heirs: dict = {}
        for c in self.by_id.values():
            _heirs.setdefault(index_free(c.output_file), []).append(c)
        heir_of = {k: v[0] for k, v in _heirs.items() if len(v) == 1}
        stale: list = []
        for name, e in sorted(dict(led.files).items()):
            if name in kept or not (out / name).is_file():
                continue
            cid = e.get("cut_id")
            owner = self.by_id.get(cid)
            tgt = target_of.get(name)
            if owner is not None:
                if owner.output_file == name:
                    continue          # its own clip is re-encoded over it
                renumbered = (index_free(name) == index_free(owner.output_file)
                              and _number_of(name) != _number_of(owner.output_file))
                why = ("its clip changed number and this folder's record cannot prove this "
                       "tool wrote it" if renumbered else
                       "an older copy of a clip this run writes under another name")
                self._supersede(owner, name, renumbered, why)
            elif tgt is not None:
                if cid in on_timeline:
                    self.displace[name] = "another clip of this run is written under its name"
                # else: see the relink note below — overwritten, as an export always has
            elif cid in on_timeline or not timeline_ids:
                continue              # a clip on the timeline this run did not select
            elif heir_of.get(index_free(name)) is not None:
                self._supersede(heir_of[index_free(name)], name, False,
                                "the edit moved its clip to another number (or its media "
                                "path changed); set aside once the new file landed")
            else:
                stale.append((name, "no clip on this timeline matches it any more"))
        # A folder with no record: files matched by filename alone under an old number.
        # Nothing records which clip they are, so they are never deleted — moved aside once
        # the clip they matched has landed under its new number.
        legacy = set(getattr(args, "resume_legacy_stale", None) or ())
        for old, new in (getattr(args, "resume_renumbered", None) or ()):
            owner = next((c for c in self.by_id.values() if c.output_file == new), None)
            if old in legacy and owner is not None and (out / old).is_file():
                self._supersede(owner, old, False,
                                "matched a clip by filename alone, under an old number — "
                                "nothing records which clip it is")
        if stale:
            with uninterrupted():
                self._aside(stale)

    def _supersede(self, owner, name: str, renumbered: bool, why: str) -> None:
        if name in self.occupant:
            return
        self.superseded.setdefault(owner.cut_id, []).append((name, renumbered, why))
        self.occupant[name] = owner.cut_id

    # --------------------------------------------------------------------- moving aside
    def _aside(self, items: list) -> list:
        """Move each (name, why) aside, note it in the ledger, and say so on ONE `!!` line —
        called inside uninterrupted(), so the three cannot be separated by a Cancel."""
        done = []
        for name, why in items:
            where = move_aside(self.out, name)
            if where and self.led is not None:
                self.led.note_aside(name, where, why)
            done.append((name, where, why))
        ok_ = [(n, why) for n, w, why in done if w]
        stuck = [(n, why) for n, w, why in done if not w]
        if ok_:
            _warn_now(self.warnings,
                      f"{len(ok_)} file(s) in this folder could not be reused by this run and "
                      f"were moved to {ASIDE_DIR}/, not deleted: "
                      + ", ".join(f"{n} ({why})" for n, why in ok_[:6])
                      + (", …" if len(ok_) > 6 else ""))
        if stuck:
            _warn_now(self.warnings,
                      f"{len(stuck)} file(s) in this folder could not be reused by this run "
                      f"and could not be moved aside either — they are still under their "
                      f"old names: " + ", ".join(f"{n} ({why})" for n, why in stuck[:6])
                      + (", …" if len(stuck) > 6 else ""))
        return done

    def _dispose(self, owner, old: str, renumbered: bool, why: str) -> None:
        """Rule 2 or rule 1 for one superseded copy of `owner`, whose new file is in place.

        ⚠️ THE DELETE GUARD. Only ever reached from _settle (the clip has landed under its
        new number, or is kept there) or from a landing step that puts it there in the same
        uninterrupted() step. A clip that did not land never gets here, so its file is never
        touched — pinned by check_folder's failed / offline / cancelled re-encode checks.
        """
        p = self.out / old
        if not p.is_file():
            return
        if renumbered and self.led is not None and self.led.vouches(old, owner.cut_id):
            try:
                p.unlink()
            except OSError:
                self._aside([(old, why)])
                return
            self.led.forget(old)
            self.deleted.append((old, owner.output_file))
            say(f"    renumbered: {old} -> {owner.output_file} (re-encoded; the old-numbered "
                f"copy this tool wrote is deleted)")
        else:
            self._aside([(old, why)])

    def _dispose_at(self, name: str) -> None:
        cid = self.occupant.get(name)
        owner = self.by_id.get(cid)
        if owner is None:
            return
        rest = []
        for old, renumbered, why in self.superseded.get(cid, []):
            if old == name:
                self._dispose(owner, old, renumbered, why)
            else:
                rest.append((old, renumbered, why))
        self.superseded[cid] = rest

    # -------------------------------------------------------------------- landing a clip
    def still_needed_by(self, name: str):
        """The clip of this run whose not-replaced earlier file sits at `name`, or None."""
        cid = self.occupant.get(name)
        if (cid is None or cid in self.landed or cid not in self.by_id
                or not (self.out / name).is_file()):
            return None
        if not any(old == name for old, _, _ in self.superseded.get(cid, [])):
            return None
        return self.by_id[cid]

    def _blocker(self, cut):
        holder = self.still_needed_by(cut.output_file)
        return None if holder is None or holder.cut_id == cut.cut_id else holder.cut_id

    def commit(self, cut, part: Path, out_path: Path) -> bool:
        """Put `cut`'s verified partial under its delivery name. True when it is PARKED:
        its name still holds another clip's only copy, so the partial waits (hidden, and
        still registered for a Cancel to remove) until that clip lands."""
        with uninterrupted():
            return self._commit_locked(cut, part, out_path, late=False)

    def _commit_locked(self, cut, part: Path, out_path: Path, late: bool) -> bool:
        blocker = self._blocker(cut)
        if blocker is None:
            self._land([(cut, part, out_path)], late_from=0 if late else 1)
            return False
        if blocker in self.done:
            self._refuse(cut, part, blocker, late)
            return False
        chain = [cut.cut_id]
        b = blocker
        while b in self.parked and b not in chain:
            chain.append(b)
            b = self.parked[b][3]
        if b == cut.cut_id:
            # A cycle: every clip in it has its fresh encode ready, so they all land now,
            # in this one step, each disposing of the copy it replaces.
            members = [(cut, part, out_path)] + [self.parked.pop(i)[:3] for i in chain[1:]]
            self._land(members, late_from=0 if late else 1)
            return False
        self.parked[cut.cut_id] = (cut, part, out_path, blocker)
        self.parked_ids.add(cut.cut_id)
        say(f"    holding {cut.output_file} back: that name still holds "
            f"{self.by_id[blocker].clip_name}'s earlier file, which is swapped out only "
            f"once that clip lands")
        return True

    def _land(self, members: list, late_from: int) -> None:
        landed, failed = [], []
        for i, (cut, part, out_path) in enumerate(members):
            name = cut.output_file
            if self.occupant.get(name) not in (None, cut.cut_id) and out_path.is_file():
                self._dispose_at(name)
            why = self.displace.pop(name, None)
            if why and out_path.is_file():
                self._aside([(name, why)])
            try:
                os.replace(str(part), str(out_path))
            except OSError as e:
                cut.status = "failed"
                cut.error = f"encoded but could not be put in place: {e}"
                cut.output_bytes = 0
                try:
                    part.unlink()
                except OSError:
                    pass
                _release_part(part)
                failed.append(cut)
                continue
            _release_part(part)
            if self.led is not None:
                # The render's identity was read before this step (run_cut), never here.
                self.led.record(cut.output_file, cut.cut_id, cut.output_bytes,
                                render=getattr(cut, "_render_identity", None))
            self.landed.add(cut.cut_id)
            landed.append(cut)
        for i, (cut, _, _) in enumerate(members):
            self.parked.pop(cut.cut_id, None)
            if i >= late_from:
                self.late.append(cut)
        for cut in landed:
            self._settle(cut)
        for cut in failed:
            self._not_landed(cut)

    def _settle(self, cut) -> None:
        """`cut` is in place under its own name: settle its earlier copies, then land any
        clip that was waiting for one of them to leave its name."""
        self.done.add(cut.cut_id)
        self.landed.add(cut.cut_id)
        for old, renumbered, why in self.superseded.pop(cut.cut_id, []):
            self._dispose(cut, old, renumbered, why)
        for cid, (w, part, out_path, blk) in list(self.parked.items()):
            if blk == cut.cut_id and cid in self.parked:
                del self.parked[cid]
                self._commit_locked(w, part, out_path, late=True)

    def _not_landed(self, cut) -> None:
        """`cut` put nothing under its name this run: its earlier copies stay exactly where
        they are (rule 2), and a clip waiting for one of them to move cannot land."""
        if cut.cut_id in self.done:
            return
        self.done.add(cut.cut_id)
        for old, _, _ in self.superseded.get(cut.cut_id, []):
            if (self.out / old).is_file():
                self.not_redone.append((old, cut))
        for cid, (w, part, out_path, blk) in list(self.parked.items()):
            if blk == cut.cut_id and cid in self.parked:
                del self.parked[cid]
                self._refuse(w, part, cut.cut_id, late=True)

    def _refuse(self, cut, part: Path, blocker: str, late: bool) -> None:
        other = self.by_id.get(blocker)
        cut.status = "failed"
        cut.stale_delivery = True
        cut.error = (f"encoded, but {cut.output_file} still holds "
                     f"{other.clip_name if other else 'another clip'}'s earlier file, which "
                     f"is that clip's only copy because its own re-encode did not land this "
                     f"run — kept, not overwritten. Export again once that clip cuts")
        cut.output_bytes = 0
        try:
            part.unlink()
        except OSError:
            pass
        _release_part(part)
        if late:
            self.late.append(cut)
        # A refused clip is a clip that did not land: whatever waited on IT cannot land
        # either, and its own earlier copies stay.
        self._not_landed(cut)

    def finished(self, cut) -> None:
        """Called once for every cut when run_cut returns."""
        if cut.cut_id in self.parked_ids or not cut.cut_id:
            return
        with uninterrupted():
            if cut.status == "ok" or cut.cut_id in self.done:
                self.done.add(cut.cut_id)
                return
            if cut.status == "skipped_existing":
                self._settle(cut)
            else:
                self._not_landed(cut)

    def flush_parked(self) -> None:
        """After the pool: nothing may still be waiting. Only reachable if a clip never
        reported back; each waiter is then refused rather than left as a hidden partial."""
        with uninterrupted():
            for cid, (w, part, out_path, blk) in list(self.parked.items()):
                del self.parked[cid]
                self._refuse(w, part, blk, late=True)

    def drain_late(self) -> list:
        with uninterrupted():
            out, self.late = self.late, []
        return out


def tidy_before_encode(tl, args) -> "FolderTidy":
    """Build this run's FolderTidy and do the one part of it that cannot wait: moving the
    files of clips the edit no longer has. Everything else happens as each clip lands.

    ⚠️ A FILE OF A CLIP THE EDIT NO LONGER HAS IS OVERWRITTEN, NOT MOVED, WHEN THIS RUN
    WRITES THAT VERY NAME. Relinking media changes every cut id (the source path is part
    of it) while every filename stays the same; moving those first would copy a whole
    delivery into ASIDE_DIR on every relink. Replacing a same-named file is what an export
    has always done and what the panel's overwrite line promises.

    Never raises: an advisory may not fail the export it is advising about.
    """
    st = FolderTidy(tl, args)
    try:
        st.plan(args)
    except Exception as e:                                      # noqa: BLE001
        print(f"  (could not tidy this folder before cutting: {e})")
    return st


# ⚠️ 3.93 AUDIT · THE FOLDER STEPS OF AN EXPORT, IN ONE PLACE FOR EVERY FRONT END. main() had
# them inline, and xmlcut_gui.py — which imports this module and runs its own pool — called
# run_cut and write_manifest directly and took none of them: no run lock (the GUI and the panel
# could write one folder at once), no ledger, a Resume tick that kept nothing, no tidy (a clip
# the edit no longer has kept its file under the delivery), and a failed clip left an earlier
# run's file under its name. main() and the GUI now both go through these, in this order:
#
#   open_export_folder      the run lock, the folder's ledger, --resume's plan
#   ready_folder_for_encode the stale-partial sweep and FolderTidy (before the first encode)
#   settled_results         each finished cut once, parked and late landings included
#   settle_folder_after_encode   earlier runs' files out from under names not produced
#   mark_unstarted_after_stop    after a stop: what never started is failed, not pending
#
# and release_run_locks() when the run is over. `report` is where the few lines these print
# themselves go (the console for main(); the GUI passes its own log). tests/check_folder.py
# drives the GUI's export headless and fails if any of the steps is skipped.


def open_export_folder(tl, args, report=None) -> Optional[str]:
    """Hold `args.out` for this run and open its record: the steps every export takes before
    anything in the folder is read or moved. None, or the sentence refusing the run."""
    report = report or say
    # One export at a time in one folder, held before anything in it is read or moved — see
    # RUN_LOCK_NAME. A scan that only lists (the panel's reads go to its own work folder) and
    # a preview write no clips and take no lock.
    if not args.dry_run and (not args.manifest_only or getattr(args, "interactive", False)):
        _busy = take_run_lock(args.out)
        if _busy:
            return _busy

    # The folder's record of what this engine wrote into it. Opened for EVERY run, scans
    # included, because a folder an older version wrote has only its manifest as a record,
    # and this run is about to replace that manifest — see FolderLedger.open.
    args.ledger = FolderLedger.open(args.out, args)
    args.ledger.sequence = ledger_sequence({"name": tl.sequence_name,
                                            "id": getattr(tl, "sequence_id", "")})
    if args.ledger.seeded:
        args.ledger.save()

    if getattr(args, "resume", False):
        args.resume_index = build_resume_index(args.out, args.ledger)
        _ri = args.resume_index
        _plan = plan_resume(tl.cuts, _ri, args)
        args.resume_legacy_stale = _plan["legacy_stale"]
        args.resume_renumbered = _plan["renumbered"]
        # ⚠️ SETTINGS ARE JUDGED PER FILE, against the settings THAT FILE was made with.
        # This used to be one comparison against the last manifest's settings block, which
        # a --pick run, a scan or a killed run replaces or never writes (see LEDGER_NAME) —
        # so a folder of mixed settings shipped under a manifest claiming one. Warned rather
        # than refused: the panel lets someone re-export into the same folder at a different
        # crf with the tick on, and a hard stop turns a working flow into a dead end.
        # Re-cutting costs seconds; keeping the old pixels under the new settings' manifest
        # is the outcome that cannot stand.
        if _plan["n_drift"]:
            _d = _plan["drift"]
            _dtxt = "; ".join(_d[:4]) + (", …" if len(_d) > 4 else "")
            tl.warnings.append(
                f"--resume: {_plan['n_drift']} file(s) in this folder were made with "
                f"different encode settings ({_dtxt}) — not kept, re-cut at this run's "
                f"settings")
        if _plan["legacy"] and _plan["matched"]:
            tl.warnings.append(
                f"--resume kept {_plan['matched']} file(s) matched by filename alone — this "
                f"folder holds no record of the settings they were made with, so a change "
                f"of crf, size, encoder or render sound since then cannot be seen. Untick "
                f"'skip clips already there' to re-cut them")
        # ⚠️ THE LINE COUNTS WHAT THE RUN WILL DO, NOT WHAT THE FOLDER LOOKS LIKE. It
        # said `1 filename(s) ambiguous, re-cut` whenever two files shared an index-free
        # name, even when both had been matched by id and nothing was re-cut — MEASURED on
        # 3.88 in front of `Done: 0 written … 19 already there`. Every re-cut named here is
        # one the plan decided on, and a count that silently shrinks reads as the tick
        # having stopped working, so each kind is named with its reason.
        _bad = int(_ri.get("failed") or 0)
        report(f"  --resume: {_plan['matched']} clip(s) matched "
               f"{'by filename' if _plan['legacy'] else 'by id'}, "
               f"{_ri.get('files', 0)} file(s) already in the folder"
               # "not finished or damaged": a row the last run marked failed is one; a file
               # whose bytes no longer match its record — truncated, half-synced,
               # part-restored — is the other, and the audit measured that one being adopted.
               + (f", {_bad} not finished or damaged, re-cut" if _bad else "")
               + (f", {_plan['n_drift']} made at different settings, re-cut"
                  if _plan["n_drift"] else "")
               # 3.93 audit: a clip from a render is kept only over the render it was made from.
               + (f", {_plan['n_render']} whose render is not the one it was made from, re-cut"
                  if _plan.get("n_render") else "")
               + (f", {_plan['ambiguous']} filename(s) ambiguous, re-cut"
                  if _plan["ambiguous"] else "")
               + (f", {len(_plan['renumbered'])} whose number changed, re-cut under the new one"
                  if _plan["renumbered"] else "")
               + f" (matched by {_ri.get('how')})")
    return None


def ready_folder_for_encode(tl, args, report=print) -> None:
    """The last folder steps before the first encode: a dead run's partials swept, and this
    run's FolderTidy planned (sets args.tidy; None on a --dry-run)."""
    args.tidy = None
    if not args.dry_run:
        _swept = sweep_stale_partials(args.out)
        if _swept:
            report(f"  removed {len(_swept)} half-written file(s) a stopped run left in this "
                   f"folder: " + ", ".join(_swept[:4]) + (", …" if len(_swept) > 4 else ""))
        # Before the first encode, and it moves ONLY the files of clips the edit no longer
        # has; everything else waits for its clip to land — see FolderTidy.
        args.tidy = tidy_before_encode(tl, args)


def settled_results(futures, args):
    """Each finished cut once, in the order it settled. A cut that had to wait
    for another clip's old name (FolderTidy) is reported when it lands or is
    refused, by the thread that settled it, rather than when its own encode ended."""
    for fut in as_completed(futures):
        if fut.cancelled():
            continue
        c = fut.result()
        if args.tidy is None or c.cut_id not in args.tidy.parked_ids:
            yield c
        if args.tidy is not None:
            yield from args.tidy.drain_late()
    if args.tidy is not None:
        args.tidy.flush_parked()
        yield from args.tidy.drain_late()


def settle_folder_after_encode(tl, args, report=print) -> None:
    """After the pool, on a run that was not stopped: every earlier run's file moved out from
    under a name this run did not produce, and the renumbered clips' outcomes said."""
    if args.dry_run:
        return
    # Moved, noted in the ledger and said on its `!!` line in one step.
    set_aside_leftovers(tl, args)
    # ⚠️ SAID ON A `!!` LINE, BECAUSE THAT IS WHAT REACHES THE PANEL. runEngineExport
    # keeps exactly two kinds of engine line for the editor to read — `++` and `!!` —
    # and a warning printed any other way stays in the Advanced log. A folder that has
    # just lost files from its delivery names is the one thing the editor must be told.
    _deleted = list(args.tidy.deleted) if args.tidy is not None else []
    if _deleted:
        tl.warnings.append(
            f"{len(_deleted)} clip(s) changed number since this folder was exported (the "
            f"edit added or removed a clip before them): each was re-encoded under its new "
            f"number, and the old-numbered file this tool had written for it was deleted: "
            + ", ".join(f"{a} -> {b}" for a, b in _deleted[:6])
            + (", …" if len(_deleted) > 6 else ""))
        report(f"\n  !! {tl.warnings[-1]}")
    # The files set aside were each said on a `!!` line the moment they moved (see
    # FolderTidy); what is left to say is which renumbered clips did NOT land, so their
    # earlier file is still under the old number — kept, never deleted, by rule 2.
    _left = list(args.tidy.not_redone) if args.tidy is not None else []
    if _left:
        tl.warnings.append(
            f"{len(_left)} clip(s) changed number but were not re-encoded this run, so "
            f"the file each already had stays under its OLD number, untouched: "
            + ", ".join(f"{n} ({c.status})" for n, c in _left[:6])
            + (", …" if len(_left) > 6 else ""))
        report(f"\n  !! {tl.warnings[-1]}")


def mark_unstarted_after_stop(tl, args, how: str = "interrupted (Ctrl-C)",
                              again: str = "Run the same command again with --resume to "
                                           "finish",
                              resume: str = "--resume", report=print) -> list:
    """After a stop: every cut that never started is recorded as failed (not left pending),
    and the delivery names still wearing an earlier run's file are named. Returns those cuts.
    Nothing is moved aside on a stop — a stop that emptied the folder is the failure
    FolderTidy exists to prevent."""
    _uncut = [c for c in tl.cuts if c.status == "pending"]
    for c in _uncut:
        c.status = "failed"
        c.error = (f"not cut — the run was {how} before this clip "
                   f"started. {again}")
    tl.warnings.append(
        f"{how}: {len(_uncut)} of {len(tl.cuts)} clip(s) were never "
        f"started and are recorded as failed; clips that were encoding when it came "
        f"are failed or finished as ffmpeg left them. This is NOT a complete export")
    # ⚠️ AND WHICH OF THEM STILL WEAR AN EARLIER RUN'S FILE. Nothing is moved aside on an
    # interrupt — a stop that emptied the folder is the failure FolderTidy exists to
    # prevent — so over an earlier export every clip this run did not finish keeps the
    # old file under its delivery name, possibly at other settings. MEASURED in the 3.89
    # merge review: crf 40 folder, Ctrl-C into a crf 18 re-export, 12 crf-40 files left
    # under delivery names beside 7 new ones and no line naming any of them. This run
    # writes through hidden partial names, so a delivery-named file for a clip it did
    # not finish can only be an earlier run's.
    _old = [c.output_file for c in tl.cuts
            if c.status == "failed" and c.output_file and (args.out / c.output_file).is_file()]
    if _old:
        tl.warnings.append(
            f"{len(_old)} clip(s) this run did not finish still hold an EARLIER run's file "
            f"under their name "
            f"— kept, not this run's, and possibly at other settings; {resume} re-cuts them: "
            + ", ".join(_old[:6]) + (", …" if len(_old) > 6 else ""))
    for _w in tl.warnings[-2 if _old else -1:]:
        report(f"  !! {_w}")
    return _uncut


# ⚠️ WHAT A CANCEL HAS TO CLEAN UP, held where a signal handler can reach it. The panel's
# Cancel is a group SIGTERM and, 1.5 s later, SIGKILL to whatever is left; the engine
# installed no handler, so python died at once and every in-flight partial stayed — hidden,
# moov-less, and removed by nothing (MEASURED: eight of them, 60 MB, after a Cancel 4 s into
# a 4K export). Each encode registers its process and its partial here for as long as it
# runs.
#
# ⚠️ RE-ENTRANT, because the handler takes it on the MAIN thread, and the main thread also
# spawns through it (the audio mixes run there after the pool): a Cancel landing while the
# main thread holds a plain Lock would leave the handler waiting on its own thread forever.
_INFLIGHT_LOCK = threading.RLock()
_INFLIGHT_PROCS: set = set()
_INFLIGHT_PARTS: set = set()
_INFLIGHT_FUTURES: list = []
# Set by the stop handler, first thing, before it looks at what is running.
_STOP = threading.Event()
# ⚠️ TWO INTERRUPTS, TWO RIGHT ANSWERS, AND THE 3.89 MERGE HAD TO RECONCILE THEM. The panel's
# Cancel is SIGTERM to the process group: the engine must stop every encode, take the
# partials away and DIE of the signal, which the panel reads as "cancelled". A Ctrl-C in a
# terminal is SIGINT: the same clean-up, but then main() writes a manifest that says what
# finished and exits 130, so the next --resume and the person at the terminal both know
# where it stopped. The two were fixed separately; as merged, the stop handler took SIGINT
# too and died of it, and main()'s KeyboardInterrupt path could never run. So while the
# encode loop is running — the only place that path exists — SIGINT is cleaned up and then
# handed back as KeyboardInterrupt; anywhere else it dies clean like SIGTERM.
_SIGINT_TO_MAIN: list = [False]
# ⚠️ THE HANDLER IS NOT RE-ENTERED. Python runs it on the main thread between bytecodes, so a
# second signal can land INSIDE the first handler's run — two Ctrl-Cs 0.5 ms apart do it.
# The nested run could not take the commit lock (its own outer run held it), cleaned up
# anyway and raised KeyboardInterrupt out THROUGH the outer run, which therefore never
# released the lock: main() then waited in shutdown() for workers that were each waiting on
# that lock. MEASURED in the 3.89 merge review: hung until a third Ctrl-C, in repeated runs
# at a 0.5 ms gap. So a signal that arrives while the handler is running only records itself
# here; the running handler already does everything a stop needs, and reads these at its end.
_IN_STOP_HANDLER: list = [False]
_NESTED_SIGNALS: list = []

# ⚠️ WHAT A CANCEL MAY NOT SPLIT. Some changes to the folder are two or three steps that
# only make sense together: a clip's re-encode put under its new name and its old-numbered
# file deleted, a file moved aside and the ledger noting where and the `!!` line saying so.
# A Cancel between them is how the build before ended with an empty delivery and a log
# that said nothing (see FolderTidy). Each such step holds _COMMIT_LOCK, and the stop
# handler takes it before it kills anything, so it lands between steps, never inside one.
# A step is file renames and one small JSON write — milliseconds, far inside the 1.5 s the
# panel waits before its SIGKILL.
_COMMIT_LOCK = threading.Lock()
_COMMIT_OWNER: list = [None]
_DEFERRED_SIGNALS: list = []
# True from BEFORE the main thread asks for the lock until AFTER it has given it back. The
# owner alone left two one-bytecode gaps — lock taken, owner not yet set; owner cleared, lock
# not yet released — and a Ctrl-C in either found no owner, waited out its 1 s for a lock its
# own thread held, and raised out of uninterrupted() with the lock still taken: every worker
# then waited on it forever. MEASURED in the 3.89 merge review with a trace-placed SIGINT:
# hung at both lines, and main passes through a step once per finished cut.
_MAIN_IN_STEP: list = [False]
# When the first stop was held for a step. A step is milliseconds; one that has held a stop
# for STEP_HOLD_LIMIT_S is not finishing, it is stuck (a write to a hung network mount), and
# a press after that goes through the way it did before steps existed — which cannot hit the
# gaps above, because those are one bytecode wide.
_DEFERRED_SINCE: list = [0.0]
STEP_HOLD_LIMIT_S = 2.0


@contextlib.contextmanager
def uninterrupted():
    """One step of folder changes that a Cancel waits for. Re-entrant on one thread.

    ⚠️ THE MAIN THREAD CANNOT WAIT FOR ITSELF. Python runs the signal handler ON the main
    thread, so a Cancel arriving while the main thread is inside a step would block on a
    lock its own thread holds. The handler sees that, only records the signal, and the step
    re-delivers it the moment it ends.
    """
    me = threading.get_ident()
    if _COMMIT_OWNER[0] == me:
        yield
        return
    on_main = threading.current_thread() is threading.main_thread()
    if on_main:
        _MAIN_IN_STEP[0] = True           # see _MAIN_IN_STEP: before the lock, not after
    try:
        _COMMIT_LOCK.acquire()
        try:
            _COMMIT_OWNER[0] = me
            yield
        finally:
            _COMMIT_OWNER[0] = None
            _COMMIT_LOCK.release()
    finally:
        if on_main:
            _MAIN_IN_STEP[0] = False
            if _DEFERRED_SIGNALS:
                # All of them, not one: a TERM outranks a Ctrl-C, and a second Ctrl-C held
                # here is still the "stop waiting" press (see _IN_STOP_HANDLER).
                _held = list(_DEFERRED_SIGNALS)
                _DEFERRED_SIGNALS.clear()
                _first = next((s for s in _held if s != signal.SIGINT), _held[0])
                _held.remove(_first)
                _NESTED_SIGNALS.extend(_held)
                _stop_on_signal(_first, None)


class StopRequested(Exception):
    """The export was cancelled; nothing new may be started."""


def stop_requested() -> bool:
    return _STOP.is_set()


def _run_tracked(cmd: list[str], timeout, part: Optional[Path] = None):
    """subprocess.run(cmd, capture_output=True, text=True, timeout=timeout), registered.

    The same contract as subprocess.run — a CompletedProcess back, TimeoutExpired raised
    after the child is killed — so callers read exactly what they read before. Raises
    StopRequested instead of starting anything once a stop has been asked for.

    ⚠️ THE CHECK, THE SPAWN AND THE REGISTRATION ARE ONE STEP under _INFLIGHT_LOCK, which
    the handler takes only AFTER setting _STOP. So every child either was started before
    the handler looked — and is in the list it kills — or sees the stop and is never
    started. The first handler had neither half: the child was registered after Popen
    returned, outside the lock, and nothing refused a spawn. MEASURED on the 21-cut
    fixture with 8 jobs and the panel's Cancel: the eight partials present at SIGTERM were
    gone within 0.1 s and eight DIFFERENT ones (`.09_`..`.17_`) had replaced them — while
    the handler waited for the killed ffmpegs, each freed worker took the next queued cut —
    orphaned when the engine died and left behind by the panel's SIGKILL; SIGINT to the
    engine alone left 5 ffmpeg processes running.
    """
    with _INFLIGHT_LOCK:
        if stop_requested():
            raise StopRequested("stopped before it started (the export was cancelled)")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        _INFLIGHT_PROCS.add(p)
        if part is not None:
            _INFLIGHT_PARTS.add(part)
    with p:
        try:
            out, err = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            p.communicate()
            raise
        finally:
            with _INFLIGHT_LOCK:
                _INFLIGHT_PROCS.discard(p)
        return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def _release_part(part: Path) -> None:
    with _INFLIGHT_LOCK:
        _INFLIGHT_PARTS.discard(part)


def _stop_on_signal(signum, frame) -> None:
    """Cancel: start nothing more, stop every encode, take its partial away, then die of
    the same signal.

    ⚠️ DIE OF THE SIGNAL, DO NOT EXIT. The panel reads a signal death as the quiet
    "cancelled" case (node reports code null) and anything else as a failure — measured
    there, and the reason its close handler is written the way it is. So the handler
    tidies up and then re-raises with the default action, and the panel sees exactly what
    it saw before.

    The children are KILLED rather than asked: they already had the group's SIGTERM, and
    ffmpeg answers that by finishing its file, which took 1.1-3.3 s in the panel's own
    measurement — longer than its SIGKILL timer, and pointless for a file about to be
    deleted. The queued cuts are cancelled as well as refused (_run_tracked): a queued cut
    that is cancelled never reaches a worker at all, and one a worker has already taken
    can only be refused. MEASURED on the 21-cut fixture: with either of the two alone, no
    cut started after the SIGTERM in five Cancels each; with neither, two to four did in
    every one of five.
    """
    _STOP.set()
    if _IN_STOP_HANDLER[0]:
        _NESTED_SIGNALS.append(signum)        # see _IN_STOP_HANDLER
        return
    # Never inside a step that changes the folder — see _COMMIT_LOCK. Bounded, because the
    # one thing worse than splitting a step is a Cancel that does not stop.
    if _COMMIT_OWNER[0] == threading.get_ident() or _MAIN_IN_STEP[0]:
        _now = time.monotonic()
        if not _DEFERRED_SIGNALS:
            _DEFERRED_SINCE[0] = _now
        if _now - _DEFERRED_SINCE[0] < STEP_HOLD_LIMIT_S:
            _DEFERRED_SIGNALS.append(signum)
            return
        # Stuck: go through (below), and what was held counts as pressed before this one.
    if _DEFERRED_SIGNALS:
        # Held signals are handled by THIS run, never left behind: a stale one would later be
        # re-delivered into an unrelated step (the manifest write) or defeat the hold limit.
        _NESTED_SIGNALS.extend(_DEFERRED_SIGNALS)
        _DEFERRED_SIGNALS.clear()
    _IN_STOP_HANDLER[0] = True
    try:
        _stop_everything(signum)
    finally:
        _IN_STOP_HANDLER[0] = False


def _stop_everything(signum) -> None:
    """The body of _stop_on_signal, run once however many signals arrive during it."""
    _got_commit = _COMMIT_LOCK.acquire(timeout=1.0)
    with _INFLIGHT_LOCK:
        procs, parts = list(_INFLIGHT_PROCS), list(_INFLIGHT_PARTS)
        futures = list(_INFLIGHT_FUTURES)
    for f in futures:
        try:
            f.cancel()
        except Exception:                                       # noqa: BLE001
            pass
    for p in procs:
        try:
            p.kill()
        except OSError:
            pass
    for p in procs:
        try:
            p.wait(timeout=1.0)
        except Exception:                                       # noqa: BLE001
            pass
    for part in parts:
        try:
            part.unlink()
        except OSError:
            pass
    # A TERM or HUP that came in while this ran outranks a Ctrl-C: the panel's Cancel must
    # still end in the signal death it reads as "cancelled" (see the docstring above).
    _fatal = [s for s in _NESTED_SIGNALS if s != signal.SIGINT]
    if _fatal:
        signum = _fatal[0]
    if signum == signal.SIGINT and _SIGINT_TO_MAIN[0]:
        # The terminal's Ctrl-C, inside the encode loop: hand it to main(), which writes the
        # manifest. ⚠️ The commit lock is a plain Lock and this process now lives on, so it
        # is released first — main()'s next folder step would otherwise wait for itself.
        # A second Ctrl-C that landed while this ran is the "stop waiting" press, and main()
        # reads it from _NESTED_SIGNALS before it waits.
        if _got_commit:
            _COMMIT_LOCK.release()
        raise KeyboardInterrupt
    # The folder's run lock goes with the run (take_run_lock); a signal death runs no atexit.
    release_run_locks()
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def install_stop_handler() -> None:
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(s, _stop_on_signal)
        except (ValueError, OSError, AttributeError):
            pass                          # not the main thread, or no such signal here


def assign_output_names(cuts: list[Cut], container: str, seq_fps: float,
                        cut_from: str = "source", pad_to: int = 0) -> None:
    """Name every clip before anything is cut.

    Done here rather than inside run_cut for two reasons: a scan can then show and export
    the filenames without encoding anything (output_file used to be blank until a cut ran),
    and the index width can be chosen from the total, so 100+ clips still sort correctly
    instead of "100" landing before "99".

    Shape: index _ (start-end) _ the SOURCE file's name. The source name rather than the
    clip name because that is what you go looking for when you want the original.

    `cut_from` decides which clock (start-end) is counted on — see tc_range. It is a
    PARAMETER and not a module flag on purpose: run_cut re-names a single cut when it
    arrives without one, and if that path could answer the question differently from the
    batch pass, --resume would compare a name built one way against a name recorded the
    other and re-encode a folder that was already complete. Both call sites read it from
    cut_from_of(args).

    `pad_to` is the biggest number the WHOLE timeline hands out, for a narrowed run that
    keeps the whole timeline's numbers. 0 means "this list is the whole story".
    """
    # ⚠️ FROM THE BIGGEST NUMBER PRESENT, not from how many clips are in the list. On a
    # picked run the two are different — three clips can be numbered 07, 42 and 105 — and
    # padding to len("3") would print 105 beside 07 and sort them wrongly.
    #
    # ⚠️ AND ON A NARROWED RUN, "PRESENT" MEANS THE WHOLE TIMELINE, NOT THIS LIST. A run
    # narrowed by --pick or --ext keeps each clip's full-timeline number precisely so a
    # re-export REPLACES the file it was meant to replace — and the number alone is not the
    # name. MEASURED on a 105-clip timeline: the full run wrote 042_(06.83-07.17)_CAM_B.mp4,
    # a re-export of that one ticked row wrote 42_(06.83-07.17)_CAM_B.mp4 beside it, and the
    # run's own stray advisory then called the real deliverable "probably an earlier export".
    # The biggest number in a pick of rows 7 and 42 is 42, so the width came out as 2. The
    # caller passes the timeline's biggest number, taken BEFORE the filters ran.
    pad = max(2, len(str(max(max((c.index for c in cuts), default=len(cuts)),
                             int(pad_to or 0)))))
    for c in cuts:
        ext = ".m4a" if c.track_type == "audio" else f".{container}"
        stem = Path(c.source_path).stem or c.clip_name or "clip"
        c.output_file = (f"{c.index:0{pad}d}_{tc_range(c, seq_fps, cut_from)}"
                         f"_{sanitize(stem, 40)}{ext}")


_SAY_LOCK = threading.Lock()


def say(line: str) -> None:
    """Print one line atomically from a worker thread."""
    with _SAY_LOCK:
        print(line, flush=True)


def pinned_frame_count(cmd: list[str]) -> Optional[int]:
    """How many frames this command ASKED ffmpeg for, or None when it pinned nothing.

    Read out of the built command rather than off `cut.duration_frames`, and that is the
    whole point: under --fps the pin is converted to OUTPUT frames (see build_command),
    under a reverse or a ramp it is the resampled count, and comparing the delivery with
    the cut's timeline length instead would fail every retimed clip. The command is the
    only place the two numbers are already reconciled.

    Last occurrence wins — nothing emits two today, but a later branch that overrode the
    pin would mean the last one is the one ffmpeg obeys.
    """
    want = None
    for i in range(len(cmd) - 1):
        if cmd[i] == "-frames:v":
            try:
                want = int(cmd[i + 1])
            except (TypeError, ValueError):
                want = None
    return want


_PROGRESS_FRAME_RE = re.compile(r"^frame=\s*(\d+)\s*$", re.M)


def progress_frames(stdout: str) -> Optional[int]:
    """The frame count ffmpeg's own -progress stream ended on, or None if it said none.

    -progress writes a block of key=value lines every second and one final block, so the
    LAST frame= is the finished count. None (rather than 0) when there is no frame= at
    all, because "no evidence" and "zero frames" have to be told apart: an audio-only
    encode legitimately reports neither, and treating that as zero would fail every audio
    cut in the export.
    """
    m = _PROGRESS_FRAME_RE.findall(stdout or "")
    return int(m[-1]) if m else None


# ⚠️ THE SAME RECEIPT, FOR THE BRANCH WITH NO FRAMES TO COUNT. -progress emits out_time_ms
# beside frame=, and it was already on stdout and unread: the engine-shaped command for a
# 2.0 s audio cut whose source ends 1.0 s in prints `out_time_ms=1000000` where the control
# prints `out_time_ms=2000000`. `N/A` appears in the block ffmpeg writes before the first
# packet, so the pattern takes digits only and the LAST match wins, exactly as frame= does.
_PROGRESS_TIME_RE = re.compile(r"^out_time_ms=\s*(\d+)\s*$", re.M)


def progress_seconds(stdout: str) -> Optional[float]:
    """How many seconds of output ffmpeg's own -progress stream ended on, or None.

    None rather than 0.0 when there is no usable out_time_ms at all, for the reason
    progress_frames() returns None: "no evidence" and "nothing was written" are different
    answers, and only one of them is a reason to fail a clip.
    """
    m = _PROGRESS_TIME_RE.findall(stdout or "")
    return int(m[-1]) / 1_000_000.0 if m else None


def output_stream_count(path: Path) -> int:
    """How many media streams the delivered file actually holds.

    Only asked on the branches that pin no frame count, where there is nothing else to
    contradict a container that muxed a header and no payload. Returns -1 — "could not
    tell" — when ffprobe itself cannot be run, so an unavailable probe never invents a
    failure for a file that may be perfectly good.
    """
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=index",
                            "-of", "csv=p=0", str(path)],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return -1
    if r.returncode != 0:
        return -1
    return len([ln for ln in (r.stdout or "").splitlines() if ln.strip()])


def _announce(cut: Cut) -> None:
    """The `>>` line that tells the panel a clip has started (or is being kept)."""
    # Announced BEFORE the encode, not after. With JOBS clips running at once, reporting
    # only on completion means nothing is said for the entire length of the first encode —
    # and a single long clip on network media can hold that silence for minutes.
    #
    # ⚠️ A clip this run SKIPS announces itself too (_resume_skip calls this). The panel
    # marks its rows from these lines, and a resumed run announced nothing for the clips it
    # skipped — so their rows sat showing an estimate for a file that already existed, right
    # up until the manifest landed at the very end. Announcing then immediately reporting
    # HAVE costs one line and makes the run legible while it happens.
    #
    # The KEY as well as the name. The panel has to put this clip's progress on the row it is
    # already showing, and a filename cannot get it there: the index in the name comes from
    # the picked set, so it changes when a tick changes, and the run's manifest — the only
    # other place the two are tied together — is not written until every clip has finished.
    # These four fields are what --pick matches on, so they are already the identity of a cut
    # everywhere else in the panel.
    #
    # ⚠️ FOUR FIELDS, NOT THREE — the out-point joined the key here for the reason it joined
    # pick_key() and render_name(): two cuts under a cross-dissolve start on the same frame of
    # the same track, and with the in-point alone both announced the SAME key. The panel put
    # the second one's "encoding" state, elapsed time and result on the first one's row, so one
    # row was told two stories and the other stayed dark for the whole run.
    #
    # Name stays LAST so an older panel's `>>\s+(.+)` still reads something sensible, and a
    # newer panel treats the key as optional for the same reason in reverse. The cost of the
    # fourth field is paid THERE and it is worth knowing exactly: a panel older than this
    # engine cannot match `[a-z]+/\d+/\d+` against `video/1/448/458`, so it takes the whole
    # tail as the filename — its rows stay dark (which is already what it does with a line
    # carrying no key at all) and its live tally over-counts what is still encoding. The bar,
    # the log and the report off the manifest are all unaffected, and both halves are
    # installed together. No single-line format can do better: the old pattern's name group
    # runs to the end of the line, so ANY field added anywhere is swallowed by it.
    say(f"  >> {cut.track_type}/{cut.track_index}/{cut.timeline_in_frames}"
        f"/{cut.timeline_out_frames} {cut.output_file}")


def _resume_skip(cut: Cut, outdir: Path, args, seq_fps: float) -> bool:
    """Keep the file plan_resume() chose for this cut, if it chose one. True when kept.

    ⚠️ DECIDED BY plan_resume() IN main(), NOT HERE. Every way this went wrong was a
    question about two cuts at once — two cuts adopting one file, a kept file wearing the
    number this run gives another clip — and a worker thread looking at one cut cannot
    answer it. So the plan is made once, before any encode starts, and this only reads it:
    a cut is skipped when the plan names the file it keeps, and never otherwise. There is
    deliberately NO `out_path.exists()` fallback: a bare existence branch once overrode
    every judgement the index had made, and measured on a killed run it kept six
    part-written files the index had just called ambiguous.
    """
    _plan = getattr(args, "resume_plan", None) or {}
    _kept = _plan.get(cut.cut_id or "") if getattr(args, "resume", False) else None
    if not _kept or not (outdir / _kept).is_file():
        return False
    try:
        cut.pix_fmt_out = pix_fmt_for(cut)
    except Exception:                                           # noqa: BLE001
        pass
    if not cut.output_file:
        assign_output_names([cut], args.container, seq_fps, cut_from_of(args))
    # Announced like an encode, so a skipped clip still identifies itself: the panel marks
    # its rows from these lines, and a resumed run once announced nothing for the clips it
    # skipped, leaving their rows on an estimate until the manifest landed at the very end.
    _announce(cut)
    cut.status = "skipped_existing"
    # ⚠️ THE MANIFEST NAMES THE FILE THAT IS THERE. plan_resume keeps a file only under the
    # exact name this run gives the clip, so this is that name; it is set from the plan
    # rather than assumed because the manifest once published names that were never
    # written (MEASURED: three ticked clips, `3 already there`, a manifest naming 01_/02_/03_
    # while the pixels sat under 19_/20_/21_).
    cut.output_file = _kept
    try:
        cut.output_bytes = (outdir / _kept).stat().st_size
    except OSError:
        pass
    return True


def run_cut(cut: Cut, outdir: Path, args, seq_fps: float = 25.0) -> Cut:
    """Cut one clip, then tell the folder's FolderTidy how it ended — on EVERY return path,
    because each way a clip can end (failed, refused, offline, kept, stopped) decides what
    happens to its earlier copies and to any clip waiting for its old name."""
    try:
        return _run_cut(cut, outdir, args, seq_fps)
    finally:
        st = getattr(args, "tidy", None)
        if st is not None and not getattr(args, "dry_run", False):
            st.finished(cut)


def _run_cut(cut: Cut, outdir: Path, args, seq_fps: float = 25.0) -> Cut:
    # ⚠️ A STOPPED RUN STARTS NOTHING. The pool hands a worker its next cut the moment the
    # last one ends, and a Cancel ENDS every running one at once — so without this each
    # worker went straight on to the next queued cut. See _run_tracked for the gate that
    # makes this certain; this one also spares the queued cuts their `>>` line and probes.
    if stop_requested():
        cut.status = "failed"
        cut.error = "stopped before it started (the export was cancelled)"
        return cut
    # A render is Premiere's output, so neither of the next two disqualifications
    # applies to it. An After Effects comp has no decodable file on disk and is refused
    # below — but Premiere resolves it through Dynamic Link while rendering, so in render
    # mode it exports like anything else. So does a clip whose media has gone offline
    # since the render was made.
    if (getattr(args, "render_dir", None) and not cut.render_path
            and cut.track_type != "audio"):           # audio cuts from source in every mode
        cut.status = "no_render"
        cut.error = ("no render for this cut — Premiere did not produce "
                     f"{render_name(cut)}")
        return cut
    # ⚠️ THE RENDER IS MEASURED, NOT TRUSTED.
    #
    # The panel confirms Premiere moved its in/out points before rendering, but that is
    # a statement of intent — it does not prove the exporter honoured the range. When it
    # did not, every render came back as the WHOLE TIMELINE, and `-frames:v` dutifully
    # trimmed each one to its cut's length: seventeen files, all of them the opening of
    # the sequence, all the right duration, all wrong. Nothing downstream could tell.
    #
    # A render's frame count is the one thing that cannot lie about this. Two frames of
    # slack, because a real range can land a frame either side of the arithmetic; beyond
    # that the file is not the range it claims to be and the cut fails.
    # ⚠️ AND A LENGTH THAT COULD NOT BE READ IS NOT A LENGTH THAT PASSED. Every defence
    # below is gated on `cut.render_frames` being truthy, so a render whose count ffprobe
    # could not report — the probe failed or timed out, or the container carries neither
    # nb_frames nor a usable duration — walked past all of them: no gross check, no
    # overshoot resolution, no warning, no note, delivered `status ok, frame_exact true`.
    # The whole reason this check exists is that a render of the WRONG RANGE is otherwise
    # undetectable, and an unreadable length is exactly the case where it is most likely.
    # Found by review; before it, that cut was the one shape with no defence at all.
    if cut.render_path and cut.duration_frames and not cut.render_frames:
        cut.status = "render_mismatch"
        cut.error = ("the render's length could not be read, so there is no way to tell "
                     "whether it is the range this cut asked for — the file may be damaged "
                     "or still downloading. Re-render this range in Premiere")
        return cut
    if cut.render_path and cut.render_frames and cut.duration_frames:
        off = cut.render_frames - cut.duration_frames
        if abs(off) > RENDER_FRAME_SLACK:
            cut.status = "render_mismatch"
            cut.error = (f"the render holds {cut.render_frames} frames but this cut is "
                         f"{cut.duration_frames} ({off:+d}) — not the range it should "
                         f"be, so it was not encoded")
            return cut
        # ⚠️ INSIDE THE SLACK AND STILL REFUSED, ON PURPOSE. A render one frame longer than
        # its cut is delivered by keeping the FIRST N frames, which is only correct if the
        # surplus frame is at the tail. resolve_render_overshoot() compares the pixels
        # against the neighbouring renders to find out; when it cannot tell, the choice is
        # between shipping a clip that may be shifted by a frame at every frame and not
        # shipping one at all, and not shipping is the one that can be noticed.
        if cut.render_overshoot == "unclear":
            cut.status = "render_mismatch"
            cut.error = (f"the render holds {cut.render_frames} frames where this cut is "
                         f"{cut.duration_frames}, and the surplus frame could not be placed "
                         f"at either end: "
                         + (cut.render_overshoot_why or "the picture was inconclusive")
                         + ". Re-render this range in Premiere, or the clip would be "
                           "delivered possibly one frame out of step with the timeline")
            return cut
        # ⚠️ A RENDER SHORTER THAN ITS CUT IS NOT REFUSED HERE, and a first draft of this
        # got that wrong. It looks unshippable and often is — but under a resampling --fps
        # it is not: 59 input frames map onto all 48 output slots, the pin is satisfied and
        # the clip is correct, which is documented policy measured on 6 Sep. Refusing it up
        # front broke that. Where the frames really are missing the post-encode count check
        # catches it a few lines below; all that was wrong there was the SENTENCE, which
        # blamed the source media for a short render.
    if cut.media_kind == "unsupported" and not cut.render_path:
        cut.status = "unsupported"
        # ⚠️ A CLIP WITH NO PATH IS NOT A DYNAMIC LINK COMP. A title, a graphic, an
        # adjustment layer or a nest carries no <pathurl>, so Path("").suffix is "" and
        # this read " is a project/comp file (Dynamic Link), not decodable media" —
        # a sentence starting with a space, naming the wrong thing. It is not only on
        # screen: it is the error column in manifest.csv, which the panel's report reads.
        if cut.source_path:
            cut.error = (f"{Path(cut.source_path).suffix} is a project/comp file "
                         f"(Dynamic Link), not decodable media — render it first")
        else:
            # Reads in the row tooltip and in the error column of the sheet, so it says the
            # same thing as the rail: what the clip is, and which mode produces it.
            cut.error = ("a title, graphic, adjustment layer or nest — Premiere draws it, "
                         "so there is no media to cut from. Timeline Render produces it")
        return cut
    # ⚠️ --resume KEEPS A VERIFIED FILE BEFORE IT ASKS WHETHER THE SOURCE CAN BE REACHED, and
    # that order is the fix. The keep is decided by plan_resume() from the folder's ledger —
    # this file, this cut, these settings, these bytes — none of which needs the source.
    # When this ran after the source checks, a clip whose camera file was merely offline
    # became `missing_source`, and the leftovers pass then moved its verified file out of
    # the delivery. MEASURED: complete folder, one camera's file moved away, --resume — the
    # four clips cut from it went to the aside folder, where the build before kept them.
    # Render refusals stay ahead of this: the render IS this run's input, so its absence
    # or wrong length is about this run, not about reachability.
    if not args.dry_run and _resume_skip(cut, outdir, args, seq_fps):
        return cut
    if not cut.source_exists and not cut.render_path:
        cut.status = "missing_source"
        cut.error = f"Source not found: {cut.source_path}"
        return cut
    # ⚠️ BEFORE THE no_audio GUARD, AND THAT ORDER IS THE FIX. The guard below reads an
    # empty audio_codec as proof that the media is silent; it is only proof when the probe
    # actually answered. When it did not, the honest failure is "I could not read this
    # source", with ffprobe's own words attached — a clip failed for a stated reason sends
    # the editor to the file, "silent source" sends them to the camera. MEASURED: with a
    # truncated .m4a the run went from 3 rows reading "source has no audio stream" to 3
    # honest failures naming `moov atom not found`; a genuinely silent source (a video-only
    # stream) still reports `silent source`, so the two cases stay distinguishable.
    if cut.probe_error and not cut.render_path:
        cut.status = "failed"
        cut.error = (f"could not read this source (ffprobe: {cut.probe_error}) — it may "
                     f"not be fully downloaded")
        return cut
    if (cut.track_type == "audio" and not cut.audio_codec
            and not getattr(args, "no_probe", False)):
        # Premiere happily puts a clip on an audio track whose source has no audio —
        # a muted camera file, an AI-generated shot. ffmpeg's own error for that is
        # "Output file does not contain any stream", which explains nothing.
        cut.status = "no_audio"
        cut.error = "source has no audio stream — nothing to extract"
        return cut

    cut.pix_fmt_out = pix_fmt_for(cut)
    if not cut.output_file:          # assign_output_names normally did this already
        assign_output_names([cut], args.container, seq_fps, cut_from_of(args),
                            int(getattr(args, "index_pad_to", 0) or 0))
    out_path = outdir / cut.output_file

    if args.dry_run:
        cut.status = "dry_run"
        return cut

    _announce(cut)

    # ⚠️ ENCODE TO A HIDDEN NAME, PUBLISH BY RENAME. Everything below writes to `part_path`
    # and the delivery name is claimed by one os.replace() after the checks pass — see
    # partial_name() for why the name is shaped the way it is. Unlinked first because a run
    # killed mid-encode leaves its partial behind, and ffmpeg appending to somebody else's
    # leftover is the one outcome worse than re-encoding.
    part_path = out_path.with_name(partial_name(out_path.name))
    try:
        part_path.unlink()
    except OSError:
        pass
    cmd = build_command(cut, part_path, args, seq_fps)
    try:
        # Tracked, so a Cancel can stop this ffmpeg and take its partial away — see
        # _stop_on_signal. Same contract as the subprocess.run it replaces.
        r = _run_tracked(cmd, args.timeout, part_path)
        if r.returncode != 0:
            cut.status = "failed"
            cut.error = (r.stderr or "").strip()[:400]
        elif not part_path.exists() or part_path.stat().st_size == 0:
            cut.status = "failed"
            cut.error = "ffmpeg produced an empty file"
        else:
            # ⚠️ EXIT 0 IS NOT A DELIVERY. Until this, an encode was accepted on three
            # facts — rc, the file existing, and size != 0 — and NOTHING counted the
            # frames in the file it had just written. Two measured cases walked straight
            # through all three and were reported `OK`, status ok, frame_exact true:
            #
            #   * a cut reaching one frame past the end of its media: `-frames:v 6` on a
            #     480-frame source seeked to 19.791667 s exits 0 with stderr exactly
            #     0 bytes and writes FIVE frames. Push the in-point fully past the end
            #     and the delivery is a 261-byte mp4 with no video stream at all —
            #     `size == 0` passes it, and the manifest certified 30 frames.
            #   * a source whose bytes are not all readable (a partly-synced cloud file,
            #     a network volume that hiccuped, an interrupted copy): ffmpeg prints
            #     `partial file` / `Decoding error` on STDERR and still exits 0. Measured
            #     end to end on a truncated source: one clip 0 frames of 36, another 46
            #     of 48, `Done: 19 written, 0 failed`.
            #
            # So the count is authoritative wherever a count was pinned, and ffmpeg's own
            # words are the fallback where none was (the audio branch and the still branch,
            # which deliberately emit no -frames:v — the render branch under a forced rate
            # used to be a third and is now pinned like the rest, see build_command).
            # Deliberately NOT the other way round: at -loglevel error a full
            # --tracks all --audio export was measured at 0 bytes of stderr on 24 of 24
            # invocations, but that is fixture media — a benign error-level line on real
            # media must not be able to reject a clip the frame count says is complete.
            #
            # `failed`, not a status of its own: counts.ok and counts.failed are the only
            # two tallies the report has, so a third status would land in neither and read
            # as "0 failed" — the very shape of silence this check exists to end.
            #
            # The unpinned branches get a THIRD test as well, and it is not redundant with
            # the other two: truncate a source .m4a and ffmpeg exits 0, writes 0 bytes of
            # stderr at -loglevel error, and delivers a 257-byte container holding NO
            # streams at all — `size == 0` passes it and there is no frame count to
            # contradict it. `-loglevel warning` would have said "Output file is empty,
            # nothing was encoded"; one ffprobe (~30 ms, and only on the branches with no
            # pin) asks the file instead of asking the log level.
            want = pinned_frame_count(cmd)
            got = progress_frames(r.stdout)
            err = (r.stderr or "").strip()
            counted = want is not None and got is not None
            # An audio cut has no frame to count, so its receipt is measured in seconds off
            # the SAME -progress stream — see progress_seconds and AUDIO_SHORT_TOLERANCE.
            # Without it the only audio delivery that could fail was one wholly past the end
            # of its media (caught as a streamless file); one that merely RAN OUT mid-range
            # was written short and reported ok, and the mix built from it went silent for
            # the missing part with nothing said.
            want_s = audio_target_seconds(cut, args, seq_fps)
            got_s = progress_seconds(r.stdout)
            timed = want_s is not None and got_s is not None
            # ⚠️ NAME THE CAUSE WHEN IT IS KNOWN. "the source is shorter than the cut, or
            # unreadable" covers two unrelated things and pointed at neither: an editor who
            # dragged nothing anywhere spent an evening looking at their footage because the
            # real answer — Premiere thinks this file is longer than it is — was not in the
            # sentence. apply_probe measured the overhang; say it, and say the fix.
            _over = _overhang_note(cut)
            # ⚠️ AND WHEN THE SHORT THING IS THE RENDER, SAY SO. Measured: a 59-frame
            # render into a 60-frame slot failed with "the source is shorter than the cut,
            # or unreadable" — about a source file that was perfectly fine and that this
            # branch never even opened. In render mode the source is not what ffmpeg read.
            # ⚠️ GATED ON WHAT FFMPEG READ, NOT ON WHAT THE METADATA SAID. The first
            # version required cut.render_frames to already admit the shortfall — so when
            # the container over-reported its length, or reported nothing, a render-mode
            # clip that came up short still blamed "the source", a file this branch never
            # opens. In render mode the source is not what ffmpeg read, ever.
            _short_render = ""
            if cut.render_path and counted and got < want:
                _known = (f"the render reports {cut.render_frames} frames"
                          if cut.render_frames else
                          "the render does not report its own length")
                _short_render = (
                    f"the RENDER came up short — ffmpeg read {got} frame(s) out of it where "
                    f"this cut is {cut.duration_frames} ({_known}). The missing frames are "
                    f"not in the file, so re-render this range in Premiere. The source "
                    f"media is not the problem")
            if counted and got != want:
                cut.status = "failed"
                cut.error = (f"ffmpeg exited 0 but wrote {got} frame(s) where {want} "
                             f"were asked for ({got - want:+d}) — "
                             + (_short_render or _over
                                or "the source is shorter than the cut, or unreadable"))
            elif timed and got_s < want_s - AUDIO_SHORT_TOLERANCE:
                cut.status = "failed"
                cut.error = (f"ffmpeg exited 0 but wrote {got_s:.3f}s of audio where "
                             f"{want_s:.3f}s were asked for ({got_s - want_s:+.3f}s) — "
                             + (_over or "the source is shorter than the cut, or unreadable"))
            elif not counted and err:
                cut.status = "failed"
                cut.error = ("ffmpeg exited 0 but reported: "
                             + err.splitlines()[-1][:300])
            elif not counted and output_stream_count(part_path) == 0:
                cut.status = "failed"
                cut.error = ("ffmpeg exited 0 but the file holds no media streams — "
                             "nothing was encoded")
            else:
                cut.status = "ok"
                # The real number, so the report shows what was written rather than what
                # was predicted. The estimate is for deciding; this is for checking.
                cut.output_bytes = part_path.stat().st_size
    except subprocess.TimeoutExpired:
        cut.status = "failed"
        cut.error = f"ffmpeg timed out after {args.timeout}s"
    except Exception as e:
        cut.status = "failed"
        cut.error = str(e)[:400]

    # ⚠️ THE DELIVERY NAME IS CLAIMED HERE AND NOWHERE ELSE. os.replace() is atomic inside
    # one directory, so the name a later --resume, the panel and the editor all read either
    # holds a clip that passed every check above or holds nothing at all. Every other exit
    # — non-zero rc, the frame count short of the pin, --timeout, an exception — deletes the
    # partial instead, which is what makes the whole run reproducible: the failure the
    # editor is told about is the state the folder is actually in.
    #
    # A rename that itself fails (the volume filled between the encode and here, the folder
    # went away with the network) FAILS THE CLIP rather than being swallowed. There is no
    # file under the delivery name in that case, and a row saying `ok` about one would be
    # the same lie this whole change exists to end.
    #
    # ⚠️ AND IT MAY HAVE TO WAIT. When this clip's name still holds ANOTHER clip's only copy
    # (two clips trading names after an edit), FolderTidy.commit keeps the finished partial
    # hidden and swaps it in once that clip lands — see FolderTidy. The partial stays
    # registered with the stop handler until then, so a Cancel takes it away.
    _st = getattr(args, "tidy", None)
    # The render this clip was made from, read NOW — before the folder step that records
    # it, which holds the commit lock and must stay short (see render_identity).
    if cut.status == "ok":
        render_identity(cut)
    if cut.status == "ok" and _st is not None:
        _st.commit(cut, part_path, out_path)
        return cut
    if cut.status == "ok":
        try:
            os.replace(str(part_path), str(out_path))
        except OSError as e:
            cut.status = "failed"
            cut.error = f"encoded but could not be put in place: {e}"
            cut.output_bytes = 0
    if cut.status != "ok":
        try:
            part_path.unlink()
        except OSError:
            pass
    _release_part(part_path)
    # ⚠️ RECORDED THE MOMENT THE NAME IS CLAIMED, not when the run ends: a run killed after
    # this line has still said which clip this file is and what it was made with, and that
    # is the whole difference between the next --resume keeping it and guessing about it.
    # (FolderTidy.commit records in the same step as the rename, for the same reason.)
    if cut.status == "ok":
        _led = getattr(args, "ledger", None)
        if _led is not None:
            _led.record(cut.output_file, cut.cut_id, cut.output_bytes,
                        render=getattr(cut, "_render_identity", None))
    return cut


# --------------------------------------------------------------------------
# manifest
# --------------------------------------------------------------------------

SECONDS_FIELDS = ("source_in_seconds", "source_duration_seconds", "duration_seconds")

# ⚠️ THE RATE IS KEPT EXACT IN MEMORY AND ROUNDED ONLY HERE, the lesson SECONDS_FIELDS
# learned about seconds, learned again about the rate. source_fps used to be stored as
# round(n/d, 6): 30000/1001 became 29.97003, about 1e-9 too high, so frame k of a tick-exact
# in-point came out k + k*1e-9 — and past k = 100,000 that is more than the 1e-4-frame
# epsilon trim_to_whole_frames() and consumed_frames() allow, the ceil promoted the start to
# k+1 and the clip lost its first frame. MEASURED on frame-ID media, 23 Sep: a 30-frame cut
# at frame 101000 of a 29.97 file was delivered 29 frames, [101001..101029], booked as an
# ordinary whole-frame trim with frame_exact true — 27.8 min into a 59.94 file, 55.6 into a
# 29.97 one, 69.5 into a 23.976 one. The manifest keeps printing the 6-decimal rate it
# always has, so nothing that reads it sees a different number.
RATE_FIELDS = ("source_fps",)


def pick_key(cut: Cut) -> tuple:
    """What identifies a clip for --pick.

    (track type, track index, timeline IN, timeline OUT). Stable against filtering and
    re-indexing, which is why it is not an index: an index shifts whenever anything else
    is filtered out.

    ⚠️ THE OUT-POINT IS LOAD-BEARING, and it is here for the reason render_name() carries
    it. This used to be a triple, on the reasoning that "two clips cannot start on the same
    frame of the same track". Under a TRANSITION they can: a cross-dissolve leaves the
    outgoing clip's overlap sitting at exactly the frame the incoming clip starts on. One
    real client timeline put a 10-frame tail of "K8 (before)" and an 88-frame "K8 (after)"
    both at frame 448 of V1.

    With the in-point alone those two cuts answered to ONE selector, so unticking either
    one dropped both from the run, and a retry of one failed clip re-encoded two. The
    out-point separates them, because a cut cannot both start and end where another one
    does without being that cut.
    """
    return (cut.track_type, int(cut.track_index), int(cut.timeline_in_frames),
            int(cut.timeline_out_frames))


def pick_matches(cut: Cut, keys: set) -> bool:
    """Whether a --pick selection names this cut.

    Four fields match exactly. THREE match any cut starting there — the old format, kept
    working on purpose; see read_pick_file().
    """
    if cut.cut_id and cut.cut_id in keys:
        return True
    k = pick_key(cut)
    return k in keys or k[:3] in keys


def unmatched_picks(keys: set, cuts: list) -> int:
    """How many selectors in a --pick file named no clip in the run.

    Counted as SELECTORS THAT MATCHED NOTHING, not as a difference of two lengths. An old
    three-field selector legitimately matches two cuts under a transition, and subtracting
    lengths reads that as -1 missing — so a file where one selector was genuinely stale and
    another matched twice came out at zero and said nothing at all. `cuts` is the list
    AFTER pick_matches() has filtered it, so every one of them matched something.
    """
    matched = set()
    for c in cuts:
        # An id selector is what matched this cut when one is present in the file; record
        # that, or a run picked entirely by id would report every selector as stale.
        if c.cut_id and c.cut_id in keys:
            matched.add(c.cut_id)
        k = pick_key(c)
        if k in keys:
            matched.add(k)
        elif k[:3] in keys:
            matched.add(k[:3])
    return len(keys - matched)


# A cut id as _assign_cut_ids writes it: 12 lowercase hex characters. Matched strictly, so
# a mistyped track type can never be mistaken for an id and silently select nothing.
CUT_ID_RE = re.compile(r"[0-9a-f]{12}")


def read_pick_file(path: Path) -> set:
    """Selectors from a --pick file. Blank lines and # comments ignored.

    Two forms, one per line:

      a CUT ID       twelve hex characters, from the manifest's `cut_id`. The only form
                     that can separate two different pictures occupying the same frames of
                     one track — see Timeline._assign_cut_ids.
      'TRACKTYPE TRACKINDEX TIMELINEIN TIMELINEOUT'   pick_key() spelled out.

    THREE FIELDS ARE STILL ACCEPTED and mean "any cut starting there". This file is an
    internal protocol between the panel and the engine and the two ship together, so a
    panel of this vintage always writes four; three arrives from a file written by hand,
    or by a panel older than this engine, and refusing it would turn a version mismatch
    into a run that will not start at all. A three-field line behaves exactly as it did
    before the out-point existed — on the one timeline where two cuts share an in-point it
    selects both — which is no worse than what it replaced.
    """
    keys = set()
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as e:
        raise SystemExit(f"error: could not read --pick file {path} ({e})")
    for n, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        # ⚠️ A SINGLE TOKEN IS A CUT ID, and it is tried FIRST because it is the only form
        # that can separate two different pictures occupying the same frames. The
        # four-field form stays exactly as it was: this file is the protocol between the
        # panel and the engine, and a panel older than this engine — or a hand-written
        # file — must keep working rather than turning a version skew into a run that
        # will not start.
        if len(parts) == 1 and CUT_ID_RE.fullmatch(parts[0]):
            keys.add(parts[0])
            continue
        if len(parts) not in (3, 4):
            raise SystemExit(f"error: {path}:{n}: expected 'TRACKTYPE TRACKINDEX "
                             f"TIMELINEIN TIMELINEOUT' or a cut id, got {line!r}")
        try:
            keys.add((parts[0], *(int(f) for f in parts[1:])))
        except ValueError:
            raise SystemExit(f"error: {path}:{n}: track index and timeline points "
                             f"must be whole numbers, got {line!r}")
    if not keys:
        raise SystemExit(f"error: {path} selected no clips — nothing would be cut")
    return keys


def describe(cut: Cut) -> dict:
    """How a cut should be presented: status wording, notes, and a severity class.

    ONE definition, because there are now three front ends — the browser GUI, the
    Premiere panel and the CLI — and they had already drifted: the GUI worded
    `no_audio` as "silent source" and the panel said nothing at all. Anything that
    reads a Cut for display should come through here.

    Returns {"status", "notes", "kind", "cuttable"}. `kind` is one of "", "ok", "ramp",
    "warn", "bad" — a class name in both front ends.
    """
    # A render makes a cut cuttable whatever the source is doing: the pixels come from
    # Premiere, so offline media and Dynamic Link comps both export.
    #
    # ⚠️ render_planned COUNTS HERE, and that is the whole point of it. At SCAN time no
    # render exists yet, so an .aep and an offline clip both reported cuttable=false — and
    # the panel dropped them into its "cannot be cut" group with the tick box DISABLED. The
    # engine's support for them was real and completely unreachable: the panel never asked
    # Premiere to render what it had already decided could not be cut.
    #
    # Video only. An audio cut has no render coming, so promising one would put a clip in
    # the list that nothing can produce.
    cuttable = bool(cut.render_path) or (
        cut.render_planned and cut.track_type == "video") or (
        cut.source_exists and cut.media_kind != "unsupported")

    if cut.status == "pending":
        # Unsupported is checked FIRST, matching run_cut: an .aep is a Dynamic Link comp
        # whether or not it happens to be on disk, and "missing source" would send you
        # hunting for a path when the fix is to render it out.
        if cut.render_planned or cut.render_path:
            # In render mode neither of the two below is a problem: Premiere resolves a
            # Dynamic Link comp while rendering, and never opens the source file at all.
            status = ("ready — from render" if cut.track_type == "video"
                      else "missing source" if not cut.source_exists
                      else "ready")
        else:
            status = (("AE comp — render it"
                       if cut.source_path.lower().endswith((".aep", ".prproj", ".aet"))
                       else "graphic — needs a render")
                      if cut.media_kind == "unsupported"
                      else "missing source" if not cut.source_exists
                      else "ready")
    else:
        status = {"ok": "written", "skipped_existing": "already there",
                  "no_audio": "silent source",
                  "no_render": "no render",
                  # Short on purpose: this is a table cell in a panel that can be
                  # 320px wide. "wrong range rendered" measured 106px of text in a
                  # 104px column and was clipped. The numbers are in `error`.
                  "render_mismatch": "wrong range",
                  "missing_source": "missing source"}.get(cut.status, cut.status)

    notes = []
    if cut.render_path:
        # The ramp and the reverse are IN the pixels here, so the notes below that warn
        # about them would be describing work Premiere has already done correctly.
        notes.append("from render")
    if cut.transition_split:
        notes.append(f"{cut.transition_split}f to a dissolve"
                     + (f" ({cut.transition_split_end})" if cut.transition_split_end else ""))
    # ⚠️ NOT GATED ON A DISSOLVE, AND NOT ON `> 1`. This note lived inside the branch
    # above, so it could only ever appear on a cut that a transition had already split —
    # and it needed a TWO-frame disagreement to say anything. The disagreement that
    # actually ships wrong pixels is ONE frame on an ordinary cut, which is the exact
    # shape both conditions excluded. See resolve_render_overshoot().
    if cut.render_frames and cut.duration_frames:
        d = cut.render_frames - cut.duration_frames
        if d and cut.render_frames_derived:
            # The container never said how long it is; the figure being compared here is
            # one the engine worked out from the file's duration, which on a Matroska
            # carrying AAC runs past the picture. Saying "render +1 frame(s) vs the
            # timeline" about that is reporting the estimate's error as the render's.
            notes.append(f"render length estimated ({d:+d}f vs the timeline)")
        elif d:
            notes.append(f"render {d:+d} frame(s) vs the timeline")
    if cut.reversed:
        notes.append("reversed")
    if cut.speed_varies:
        notes.append(f"ramp {cut.speed_span}" if cut.speed_span else "speed ramp")
    if cut.nested_from:
        notes.append(f"in {cut.nested_from}")
    if cut.nested_trimmed:
        notes.append(f"{cut.nested_trimmed} trimmed")
    if cut.edge_in_transition:
        notes.append(f"{cut.edge_in_transition} under a transition")
    if cut.track_type == "audio":
        notes.append("audio")
    if cut.pix_fmt_out and cut.pix_fmt and cut.pix_fmt_out != cut.pix_fmt:
        notes.append(f"{cut.pix_fmt} → {cut.pix_fmt_out}")

    # ⚠️ A CLIP THAT NEVER HAD A MEDIA FILE IS NOT A FAILURE, and the line below used to make
    # it one. A title, a graphic, an adjustment layer or a nest has no <pathurl>, so
    # source_exists is False and the missing-source rule claimed it before the `warn` line
    # underneath — which is where this file has always meant these to land. The panel builds
    # its headline from `bad`, so a source-mode export of a timeline carrying 31 graphics
    # opened with "31 clips did not write. Retry below", in red, above a list headed "Why
    # each one failed" — for 31 clips that were never cuttable from source and that a retry
    # would refuse again the same way. Measured on a real 64-cut timeline: 31 ok, 31
    # unsupported, ZERO failed, and the panel called it 31 failures.
    #
    # Missing media and absent media are different things. The first is a file that moved
    # and can be relinked; the second is Premiere drawing the picture itself, which needs
    # Timeline Render and no relink will ever help.
    kind = ("bad" if cut.status in ("failed", "missing_source", "no_render",
                                    "render_mismatch")
            or (not cut.source_exists and not cut.render_path
                and cut.media_kind != "unsupported")
            else "warn" if cut.media_kind == "unsupported" or cut.status == "no_audio"
            else "ok" if cut.status in ("ok", "skipped_existing")
            else "ramp" if is_retimed(cut.speed_percent) or cut.reversed
            else "")

    return {"status": status, "notes": " · ".join(notes), "kind": kind,
            "cuttable": cuttable}


def readable(cut: Cut) -> dict:
    """Cut as a dict, with the seconds fields rounded for human/CSV consumption.

    Rounding happens HERE and nowhere earlier: the in-memory values feed the ffmpeg
    seek, where losing the 7th decimal loses a whole frame.
    """
    d = asdict(cut)
    for k in SECONDS_FIELDS + RATE_FIELDS:
        if isinstance(d.get(k), float):
            d[k] = round(d[k], 6)
    # The display wording travels IN the manifest, so a front end reading the manifest
    # gets the same status and notes as the CLI rather than reimplementing describe().
    # This is what stops the GUI and the panel drifting apart again.
    disp = describe(cut)
    d["display_status"] = disp["status"]
    d["display_notes"] = disp["notes"]
    d["display_kind"] = disp["kind"]
    d["cuttable"] = disp["cuttable"]
    return d


SHEET_COLUMNS = [
    ("file", "output_file"),
    ("clip name", "clip_name"),
    ("timeline in", "timeline_in_tc"),
    ("timeline out", "timeline_out_tc"),
    # The four columns that let a cut be checked without doing arithmetic. A cut is
    # written at the source's own speed, so it is LONGER than its timeline clip when
    # sped up and shorter when slowed. Re-speeding it by "speed %" should return it to
    # "timeline length" — near enough. It will not land on the percentage exactly,
    # because "frames" is a whole number while the range Premiere consumed is not, and
    # a ratio of two rounded integers cannot reproduce an unrounded one. On a short
    # clip that shows up as up to about 1%.
    ("speed %", "speed_percent"),
    ("cut length s", "source_duration_seconds"),
    ("frames", "source_consumed_frames"),
    ("timeline length s", "duration_seconds"),
    # Whether the editor had this clip switched ON. A dataset of finished edits should
    # hold nothing that says FALSE here; with --disabled keep it can, and then this is the
    # only column that says which rows those are.
    ("enabled", "enabled"),
    ("original name", None),          # basename of source_path
    ("original path", "source_path"),
]


def describe_encode(args, cuts=None) -> str:
    """One line naming what was actually used, for the manifest and the sheet.

    `cuts` is optional only so a caller with nothing but settings can still describe them.
    ⚠️ Pass it whenever there IS a cut list: --fps only resamples the cuts whose input
    rate differs from it, and this line used to announce "not frame exact" off the flag
    alone — flatly contradicting a manifest that now says frame_exact=true.
    """
    rate = getattr(args, "bitrate", None)
    q = f"bitrate {rate}" if parse_bitrate(rate or "") else f"crf {crf_text(crf_of(args))}"
    vcodec = vcodec_of(args)
    bits = [f"{vcodec} {q}",
            f"profile {X264_PROFILE}" if vcodec == "libx264" else "profile main",
            f"preset {getattr(args, 'x264_preset', None) or X264_PRESET}"]
    pct = scale_of(args)
    if pct < 100.0:
        bits.append(f"scaled to {pct:g}% of source resolution")
    if getattr(args, "fps", None):
        rate = f"{float(args.fps):g} fps"
        n = None if cuts is None else sum(1 for c in cuts if not c.frame_exact)
        if n is None:
            bits.append(f"RESAMPLED to {rate} — not frame exact")
        elif n == 0:
            bits.append(f"output rate {rate} — already the input rate, nothing resampled")
        else:
            bits.append(f"RESAMPLED to {rate} — {n} of {len(cuts)} cut(s) "
                        f"not frame exact")
    return ", ".join(bits)


def export_summary(tl: Timeline, args) -> dict:
    """The export-level facts: what was cut, from where, under what settings.

    ONE definition, because it now appears twice — as the manifest's top-level block and as
    the section at the top of clips.csv. A sheet and a manifest from the same run must not
    be able to describe it differently, which is the same reason describe() exists.
    """
    cut_state = ("cut list only — nothing encoded yet"
                 if all(c.status in ("pending", "dry_run") for c in tl.cuts)
                 else "cut")
    s = {
        "tool": f"{NAME} {VERSION}",
        "source_xml": str(tl.xml_path),
        "state": cut_state,
        "sequence": {
            "name": tl.sequence_name,
            # Premiere's sequenceID — only when known (a panel run); the XML-only CLI path has
            # none, and then the key is absent rather than "". See panel_sequence_id.
            **({"id": str(tl.sequence_id)} if getattr(tl, "sequence_id", "") else {}),
            "fps": round(tl.sequence_fps, 6),
            "duration_frames": tl.sequence_duration_frames,
            "duration_tc": frames_to_tc(tl.sequence_duration_frames, tl.sequence_fps),
        },
        "settings": {
            "encode": describe_encode(args, tl.cuts),
            # ⚠️ The panel reads this back to decide whether measured sizes still describe
            # the settings on screen. crf and scale_percent were already here; the encoder
            # was not, so switching to x265 left every measured size claiming to describe
            # an x264 encode and no re-measure was offered.
            "vcodec": vcodec_of(args),
            # Whether this run was ASKED for sidecar audio. Without it, "no sidecars in the
            # manifest" is indistinguishable from "none were wanted" — and a verifier cannot
            # fail a run for producing nothing it was told to produce.
            # Always true now, and recorded so a dataset built from older exports can be
            # told apart from one built after the rule stopped being optional.
            "whole_frames": True,
            # What the pixels came from. A dataset reader cannot tell a clip cut from
            # source from one cut from a render by looking at it, and they are different
            # things: one is the camera original, the other is the edit as it played.
            "cut_from": cut_from_of(args),
            # Whether a render's own sound was kept in the clips. Recorded because a reader
            # cannot tell "silent on purpose" from "sound lost" by looking at the files, and
            # because --resume has to be able to see it change — see RESUME_DRIFT_FIELDS.
            "render_audio": resume_fingerprint(args)["render_audio"],
            "render_planned": bool(getattr(args, "render_planned", False)),
            # What a nest became, and how it was applied. Both are kept: `nest` is the
            # user-facing word, `nest_applied` the state the parser actually ran, and they
            # differ whenever source mode ignores an explicit --nest one-cut.
            # ⚠️ THE MARKER THE PANEL GATES ITS MIGRATION ON. Audio A-numbers now mean
            # Premiere's tracks, not the XML's per-channel lanes, so a saved "5" from an
            # older manifest points at different material. A panel reading a manifest
            # without this key must not present old numbers under the new key.
            # The SEQUENCE's own frame size, published so a front end can price a row
            # that has no source with the same model it uses for everything else —
            # and keep following the crf and scale controls, instead of showing a
            # number frozen at whatever the scan was run with.
            "sequence_width": int(getattr(tl, "sequence_width", 0) or 0),
            "sequence_height": int(getattr(tl, "sequence_height", 0) or 0),
            # NOT hardcoded: whichever path parsed this timeline says whether it really
            # applied Premiere's audio track numbering. See Timeline.audio_numbering.
            "audio_track_numbering": str(getattr(tl, "audio_numbering", "unknown")),
            "nest": str(getattr(args, "nest_effective", "resolve")),
            "nest_applied": str(getattr(args, "nest_applied", "all")),
            "disabled": str(getattr(args, "disabled", "drop")),
            "disabled_found": int(getattr(args, "disabled_found", 0) or 0),
            "disabled_dropped": int(getattr(args, "disabled_dropped", 0) or 0),
            # Split by cause: a clipitem switched off on its own vs a whole track parked
            # with the eye or the mute. Two different gestures, and a machine reader that
            # sees only the total cannot tell "the editor rejected three takes" from "the
            # editor muted the alternate voice-over".
            "disabled_off_clip": int(getattr(args, "disabled_off_clip", 0) or 0),
            "disabled_off_track": int(getattr(args, "disabled_off_track", 0) or 0),
            "transitions": str(getattr(args, "transitions", "ignore")),
            "transitions_split": int(getattr(args, "transitions_split", 0) or 0),
            # How much of this folder is duplicated between neighbouring clips. Zero under
            # --transitions split by construction; non-zero is the accepted cost of
            # cutting each clip at its own in/out. See overlapping_cut_frames().
            # The pick_key invariant, on the record for every run. Zero is the contract;
            # non-zero means stacked layers cover identical frames with different pixels.
            "duplicate_pick_keys": int(getattr(args, "duplicate_pick_keys", 0) or 0),
            "merged_duplicates": len(getattr(tl, "merged_duplicates", []) or []),
            # The pairs themselves, so a dataset reader can see WHAT was merged and where
            # rather than only that the number moved.
            "merged_duplicate_cuts": list(getattr(tl, "merged_duplicates", []) or []),
            # Premiere's extra audio CHANNEL lanes, dropped as redundant copies. A separate
            # number from merged_duplicates because it has a different cause and a
            # different fix: that one is stacked layers inside a nest, this one is one
            # clipitem written once per channel. Zero on every mono timeline.
            "exploded_audio_lanes_merged": int(
                getattr(args, "exploded_lanes_merged", 0) or 0),
            "exploded_audio_lane_merges": list(
                getattr(args, "exploded_lane_merges", []) or []),
            "overlapping_pairs": int(getattr(args, "overlap_pairs", 0) or 0),
            "transitions_skipped_stacked":
                int(getattr(args, "transitions_skipped_stacked", 0) or 0),
            "overlapping_frames": int(getattr(args, "overlap_frames", 0) or 0),
            "render_dir": str(getattr(args, "render_dir", "") or ""),
            "video_track": int(getattr(args, "video_track", 0) or 0),
            "renders_matched": int(getattr(args, "render_matched", 0) or 0),
            "renders_missing": int(getattr(args, "render_missing", 0) or 0),
            "audio": bool(getattr(args, "audio", False)),
            # HOW MANY audio clipitems the timeline had for the mix to read. Without this, "every
            # cut came out silent" is indistinguishable from "the timeline had no voice-over" —
            # and a run that dropped the audio items on the floor verified clean.
            # From the TIMELINE, not from args: the plumbing that carries these to the mix is
            # exactly what a bug would break, and a count taken from the broken end reports 0 and
            # agrees with the silence it caused.
            "audio_items": len(getattr(tl, "audio_items", None) or []),
            # Every audio track the TIMELINE has, with how many items sits on each — this is
            # what the panel builds its Audio dropdown from, so it offers the tracks that exist
            # rather than a fixed list. Taken before selection; `audio_tracks` is what was used.
            "audio_tracks_available": getattr(args, "audio_tracks_available", []),
            "audio_tracks": getattr(args, "audio_tracks_used", []),
            "audio_tracks_requested": getattr(args, "audio_tracks_requested", []),
            "track_audio": getattr(args, "track_audio", []),
            # The single whole-timeline mp3: its name, size, length and how many items it holds.
            "timeline_audio": getattr(args, "timeline_audio", {}) or {},
            "crf": (None if parse_bitrate(getattr(args, "bitrate", None) or "")
                    else crf_of(args)),
            "bitrate": (getattr(args, "bitrate", None) or None),
            "x264_preset": getattr(args, "x264_preset", None) or X264_PRESET,
            # ⚠️ Present and non-null means the clips were RESAMPLED and are no longer
            # frame-exact. A dataset built from them is a different dataset.
            "output_fps": (float(args.fps) if getattr(args, "fps", None) else None),
            # ⚠️ THE AND OVER THE CUTS, not a reading of the flag. This used to be
            # `not bool(args.fps)`, which never compared a rate to anything: forcing a
            # rate the media already had marked a byte-identical export as inexact and
            # made tests/verify.py refuse to grade it. True here means EVERY cut kept its
            # frames; one resampled cut is enough to make the export a different dataset,
            # so the per-clip flags below are where the detail lives.
            "frame_exact": all(c.frame_exact for c in tl.cuts),
            # Percent of each source's own resolution. Unlike output_fps this does NOT
            # touch frame_exact: the cuts still hold exactly the frames the timeline used,
            # at fewer pixels each. Per-clip dimensions are on the clips themselves,
            # because one percentage cannot describe a timeline of mixed sources.
            "scale_percent": scale_of(args),
            "export_preset": getattr(args, "export_preset", None),
            "estimated_bytes": sum(c.estimated_bytes for c in tl.cuts),
            # "ceiling" with a target bitrate, "estimate" with a crf — they are not the
            # same kind of number and a reader should not have to guess which.
            "estimated_bytes_kind": ("ceiling" if parse_bitrate(
                getattr(args, "bitrate", None) or "") else "estimate"),
            "jobs": JOBS,
            "speed": getattr(args, "speed", "native"),
            # Which source types were left out, so the output can be read honestly
            # later: a dataset missing every still is a different dataset, and
            # nothing else in here would say so.
            "types_kept": getattr(args, "types_kept", None),
            "types_excluded": getattr(args, "types_excluded", None),
            # A partial run has to say so. Without this the manifest describes a
            # complete cut of the timeline, and a dataset built from it silently
            # omits whatever was unticked — with nothing recording that it happened.
            "picked_from": (str(getattr(args, "pick", "") or "") or None),
            "picked_count": getattr(args, "picked", None),
        },
        "warnings": tl.warnings,
        "counts": {
            "cuts": len(tl.cuts),
            # What the timeline held before --ext and --pick. Equal to `cuts` on a complete
            # run; the pair is what makes a partial export legible.
            "cuts_on_timeline": getattr(args, "cuts_before_filters", None) or len(tl.cuts),
            "unique_sources": len({c.source_path for c in tl.cuts}),
            # missing_sources means MEDIA THAT SHOULD BE THERE AND ISN'T. It used to be
            # `not c.source_exists`, which also counted every .aep — a Dynamic Link comp
            # was never a file on disk, and the fix for it is to render it, not to repair a
            # path. Reported apart now that this tally is printed at the top of the sheet:
            # a count that disagrees with the rows below it is worse than no count.
            "missing_sources": sum(1 for c in tl.cuts
                                   if not c.source_exists
                                   and c.media_kind != "unsupported"),
            "unsupported": sum(1 for c in tl.cuts if c.media_kind == "unsupported"),
            "ok": sum(1 for c in tl.cuts if c.status == "ok"),
            "failed": sum(1 for c in tl.cuts if c.status == "failed"),
            # ⚠️ TWO STATUSES THAT WERE IN NO TALLY AT ALL. run_cut refuses a render-mode cut
            # with "no_render" (Premiere never produced the range) or "render_mismatch" (the
            # render is not the range it claims); counts.failed counts only status ==
            # "failed", so a machine reader saw {cuts: 19, ok: 15, failed: 0} over a folder
            # holding 15 files and had nothing to subtract. Named separately rather than
            # folded into `failed` because the two want different actions from the reader.
            "no_render": sum(1 for c in tl.cuts if c.status == "no_render"),
            "render_mismatch": sum(1 for c in tl.cuts
                                   if c.status == "render_mismatch"),
            "skipped_existing": sum(1 for c in tl.cuts
                                    if c.status == "skipped_existing"),
        },
    }
    # Carried IN the summary so every front end reads the same sentence. The panel's report
    # showed "25 of 27 matched" and "18 written" with nothing accounting for 25 → 18; this is
    # the line that accounts for it, and it was being computed for clips.csv only.
    s["completeness"] = completeness(s)
    return s


def completeness(s: dict) -> str:
    """Whether this export is the whole timeline, and if not, what removed the rest.

    A dataset missing every still, or missing whatever was unticked, is a different dataset,
    and a folder of clips cannot say so by itself.
    """
    n, st = s["counts"], s["settings"]
    total, kept = n["cuts_on_timeline"], n["cuts"]
    # ⚠️ AND WHETHER THE FOLDER ACTUALLY HOLDS THEM. Everything above this line is a property
    # of the cut LIST — it says which clips were selected, not which ones arrived. MEASURED
    # in render mode: 19 planned ranges, three never rendered and one built at the wrong
    # length, 15 files on disk, and this sentence read "all 19 cuts on the timeline" beside
    # `Done: 15 written, 0 failed`, exit 0. The existing wording is kept intact — other
    # checks read it — and the delivery is appended to it.
    made = (n.get("ok", 0) or 0) + (n.get("skipped_existing", 0) or 0)
    short = ""
    # ⚠️ 3.93 AUDIT · DECIDED BY THE RUN'S STATE, NOT BY `made`. `if made and …` kept a scan's
    # sentence bare (nothing is made in a scan) and, with it, the one export this suffix was
    # added for: MEASURED on 3.93, every clip failed (or every render missing) -> `Done: 0
    # written`, and the manifest, clips.csv and the panel all read "all 2 cuts on the
    # timeline", word for word what a complete export says. A scan's state says it is one.
    if s.get("state") == "cut" and made < kept:
        short = f" — {made} of {kept} produced a file"
    why = []
    if st["types_kept"]:
        why.append("limited to source types " + ", ".join(st["types_kept"]))
    if st["picked_from"]:
        why.append("clips chosen by hand (" + Path(st["picked_from"]).name + ")")
    if kept >= total:
        return f"all {total} cuts on the timeline" + short
    return (f"{kept} of {total} cuts on the timeline"
            + (" — " + "; ".join(why) if why else "") + short)


def sheet_header_rows(tl: Timeline, args) -> list:
    """The export-info section that opens clips.csv, as CSV rows.

    Written as `label,value` pairs and closed with a blank line, so the sheet is still a
    well-formed CSV: a human sees the context first, and a reader that wants the table can
    skip to the first row after the blank one. manifest.json stays the clean machine-
    readable copy, which is why this can afford to be shaped for a person.
    """
    s = export_summary(tl, args)
    seq, st, n = s["sequence"], s["settings"], s["counts"]

    def listed(v):
        return ", ".join(v) if isinstance(v, list) and v else "(all)"

    rows = [
        [f"# {s['tool']}"],
        ["sequence", seq["name"]],
        ["fps", f"{seq['fps']:g}"],
        ["timeline duration", seq["duration_tc"]],
        ["source", Path(s["source_xml"]).name],
        ["state", s["state"]],
        ["encode", st["encode"]],
        ["speed", st["speed"]],
        ["source types kept", listed(st["types_kept"])],
        ["cuts", n["cuts"]],
        ["unique sources", n["unique_sources"]],
        # The one row that says whether this folder is the WHOLE timeline, and if not, what
        # took the rest away. Anyone reading the dataset later needs that before they need
        # anything else in here.
        ["completeness", s["completeness"]],
        ["written", n["ok"]],
        ["failed", n["failed"]],
        ["missing source", n["missing_sources"]],
        ["not decodable media", n["unsupported"]],
    ]
    # One row per warning. These are the places a clip's own label is knowingly
    # approximate — a flattened speed ramp above all — so they belong where the labels are,
    # not only in a JSON nobody opens.
    for w in s["warnings"]:
        rows.append(["warning", w])
    rows.append([])
    return rows


# A cell a spreadsheet would evaluate instead of showing. Sheets, Excel and Numbers all
# start a formula on a leading =; the other three are the characters those importers have
# historically also treated as a formula lead-in.
_SHEET_FORMULA_LEAD = ("=", "+", "-", "@")


def sheet_cell(v):
    """One cell for clips.csv / manifest.csv, with a formula lead-in defused.

    ⚠️ THE CLIP NAME IS WRITTEN STRAIGHT INTO THE SHEET. Measured on a copy of the fixture
    whose clip was renamed `=1+1 formula, danger`: clips.csv row 20 and manifest.csv row 2
    both carried it verbatim, so opening the sheet shows `2` where the clip name belongs.
    The name is the editor's own Premiere clip, not a stranger's, so this is a sheet that
    lies rather than an attack — but a delivery note nobody can read the names off is still
    a broken delivery note.

    ONLY the two CSVs are guarded. manifest.json is the machine copy the panel and
    --resume read, and prefixing there would break the join between the two.

    Numbers are left alone, both the numeric objects the writers pass down and a string
    that is only a number: `-0.5` is a value, not a formula, and quoting it would stop the
    sheet treating the column as numeric at all.
    """
    if not isinstance(v, str) or not v.startswith(_SHEET_FORMULA_LEAD):
        return v
    try:
        float(v)
        return v
    except ValueError:
        pass
    return "'" + v


def write_sheet(tl: Timeline, outdir: Path, args) -> Path:
    """A short, readable sheet: what this export is, then which file came from where.

    manifest.csv already holds all of this among 52 columns, which is the wrong shape for
    opening in Sheets and eyeballing. This is the ten columns you actually look things up
    by — and it matters more now that the filename no longer spells out the full timecode.

    The export-info section on top is here because the facts that decide whether a dataset
    is usable — which types were kept, whether a selection was applied, which clips carry a
    flattened ramp — lived only in manifest.json, and the file people actually open is this
    one.
    """
    path = outdir / "clips.csv"
    try:
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerows([[sheet_cell(v) for v in r] for r in sheet_header_rows(tl, args)])
            w.writerow([label for label, _ in SHEET_COLUMNS])
            for c in tl.cuts:
                row = []
                for label, attr in SHEET_COLUMNS:
                    if attr is None:
                        row.append(sheet_cell(Path(c.source_path).name))
                        continue
                    v = getattr(c, attr)
                    # Seconds are held at full precision in memory because the ffmpeg seek
                    # needs it; a sheet meant for reading does not.
                    row.append(sheet_cell(round(v, 3) if isinstance(v, float) else v))
                w.writerow(row)
    except OSError:
        drop_half_written(path)
        raise
    return path


def drop_half_written(path: Path) -> None:
    """Remove a manifest file a failed write only got part of the way through.

    A destination that fills mid-write leaves a file that opens, parses as far as it goes,
    and describes a fraction of the export while looking whole. No file at all is the
    honest outcome, and the run says so on the way out.
    """
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def write_manifest(tl: Timeline, outdir: Path, args) -> tuple[Path, Path, Path]:
    """The three files that describe the export. Raises OSError if one cannot be written.

    Deliberately still RAISES rather than swallowing: a manifest is a deliverable, not an
    advisory, which is the opposite of the strays check that catches everything so it
    cannot fail a completed export. Callers turn it into their own kind of failure —
    main() into a one-line exit, the browser GUI into a message in its own log.

    ⚠️ 3.93 AUDIT · IT NEVER CREATES THE FOLDER. This did `mkdir(parents=True)`, so a
    destination moved, renamed or unmounted while the clips were being written was REBUILT
    at the end of the run, holding only the cut list: MEASURED on 3.93, Output/ renamed
    after the first clip landed -> `Done: 1 written, 23 failed`, exit 0, and
    Output/ACT/v1.2/raw back in the product with a manifest calling `ok` a clip that sat in
    the moved folder — the panel's "nothing creates Output/" broken for the length of the
    run, and a Retry into the rebuilt folder then delivered a silently incomplete set. Every
    caller has made the folder already (main() and the GUI both, before the first clip), so
    a folder missing here can only have gone during the run; see write_manifest_or_exit.
    """
    if not outdir.is_dir():
        raise FileNotFoundError(2, "the destination folder is no longer there", str(outdir))
    rows = [readable(c) for c in tl.cuts]
    for r in rows:
        r["filters"] = "; ".join(r["filters"])

    # ⚠️ ONE STEP A STOP WAITS FOR (see uninterrupted). A signal that killed the engine
    # mid-write left a truncated manifest.json — MEASURED in the 3.89 merge review at 40,947
    # and 24,570 bytes, unparseable, and 0 bytes after a panel Cancel — with no clips.csv
    # beside it. The three files are ~40 KB of local writes; the stop lands after them.
    with uninterrupted():
        return _write_manifest_files(tl, outdir, args, rows)


def _write_manifest_files(tl: Timeline, outdir: Path, args, rows) -> tuple[Path, Path, Path]:
    csv_path = outdir / "manifest.csv"
    if rows:
        try:
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows([{k: sheet_cell(v) for k, v in r.items()} for r in rows])
        except OSError:
            drop_half_written(csv_path)
            raise

    json_path = outdir / "manifest.json"
    doc = export_summary(tl, args)
    doc["markers"] = tl.markers
    doc["clips"] = [readable(c) for c in tl.cuts]
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
    except OSError:
        drop_half_written(json_path)
        raise
    return csv_path, json_path, write_sheet(tl, outdir, args)


def write_manifest_or_exit(tl: Timeline, outdir: Path, args) -> tuple[Path, Path, Path]:
    """write_manifest, with a write that fails said in one line instead of a traceback.

    ⚠️ THIS USED TO END A FINISHED EXPORT IN A RAW TRACEBACK. Measured: a scan whose --out
    already held a DIRECTORY called manifest.json printed the whole summary, then
    `IsADirectoryError: [Errno 21] Is a directory: …/manifest.json` out of write_manifest,
    over a folder holding manifest.csv and no clips.csv. The hand-made directory is only
    the cheapest way to stage it; the shape that reaches this shop is a destination that
    fills or unmounts while the clips are being written.

    The exit stays non-zero — the cut list is a deliverable and its absence must be a
    failure — but the clips are on disk and --resume reclaims them, so the message says so
    rather than leaving the editor to guess whether the export has to be run again.
    """
    try:
        return write_manifest(tl, outdir, args)
    except OSError as e:
        done = sum(1 for c in tl.cuts if getattr(c, "status", "") == "ok")
        if not outdir.is_dir():
            # The folder went away during the run (see write_manifest). Said on a `!!` line,
            # the prefix the panel shows the editor, and nothing is recreated anywhere.
            say(f"\n  !! The destination {outdir} is no longer there — it was moved, renamed "
                f"or unmounted while this run was writing into it. Nothing was recreated in "
                f"its place and no cut list was written"
                + (f"; the {done} clip(s) this run finished went with the folder."
                   if done else "."))
            raise SystemExit(
                f"error: the destination {outdir} disappeared during the run, so this export "
                f"has no cut list and is not a finished delivery. Put the folder back (or "
                f"choose it again) and export again.")
        # The three files are written in turn, so an error partway leaves some of them
        # absent and any earlier run's copies looking current. Naming that is cheaper than
        # deleting files that may be the only record of anything.
        raise SystemExit(
            f"error: the cut list could not be written to {outdir} ({e}). This folder's "
            f"cut list is incomplete — do not read it as a finished export. "
            + (f"The {done} clip(s) this run already encoded are still there, so re-run "
               f"with --resume once the destination is writable and they will not be cut "
               f"again." if done else "No clips were written either."))


def export_held_in(outdir: Path) -> int:
    """How many ENCODED clips the manifest already in `outdir` records; 0 for none.

    "Encoded" is the same test build_resume_index trusts — a row whose status is `ok` or
    `skipped_existing` — because the point is to protect exactly the record --resume reads.
    A folder holding only an earlier scan or dry run (every row pending or dry_run) holds
    nothing to protect, so the panel's own re-reads into its scan folder go on as before.
    An unreadable or foreign manifest.json counts as nothing: --resume ignores it too.
    """
    try:
        data = json.loads((Path(outdir) / "manifest.json").read_text(encoding="utf-8"))
        rows = data.get("clips") or []
        return sum(1 for c in rows if isinstance(c, dict)
                   and str(c.get("status") or "") in ("ok", "skipped_existing"))
    except (OSError, ValueError, AttributeError):
        return 0


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def clean_dropped_path(raw: str) -> str:
    """Finder drag-and-drop adds quotes and backslash-escapes spaces."""
    p = raw.strip()
    if len(p) >= 2 and p[0] == p[-1] and p[0] in "\"'":
        p = p[1:-1]
    p = re.sub(r"\\(.)", r"\1", p)          # unescape \  \( etc.
    return os.path.expanduser(p.strip())


def interactive_setup(args) -> None:
    """Walk the user through it when xmlcut is run with no arguments."""
    print("=" * 62)
    print(f"  {NAME} — Premiere timeline into individual clips")
    print("=" * 62)
    print("\nIn Premiere: File > Export > Final Cut Pro XML...")
    print("Then drag that XML file into this window and press return.\n")

    while True:
        raw = input("XML file: ").strip()
        if not raw:
            sys.exit("Nothing entered — stopping.")
        path = Path(clean_dropped_path(raw))
        if path.is_file():
            args.xml = path
            break
        print(f"  Can't find that file. Try dragging it in again.\n")

    seqs = Timeline.list_sequences(args.xml)
    if len(seqs) > 1:
        print(f"\n{len(seqs)} sequences in this file:\n")
        print(f"  {'#':>3}  {'name':40s} {'fps':>6s} {'duration':>12s} {'clips':>7s}")
        for s in seqs:
            print(f"  {s['index']:>3}  {s['name'][:40]:40s} {s['fps']:>6g} "
                  f"{s['duration_tc']:>12s} {s['clip_count']:>7d}")
        while True:
            pick = input(f"\nWhich sequence? [1-{len(seqs)}, default 1]: ").strip() or "1"
            if pick.isdigit() and 1 <= int(pick) <= len(seqs):
                # ⚠️ AN INT, NOT THE TYPED STRING. The number typed is a row of the list
                # above, i.e. a POSITION; as a bare "1" it was also read as a NAME and
                # refused as ambiguous on an XML whose sequences are named "2" and "1".
                args.sequence = int(pick)
                break
            print("  Enter one of the numbers above.")

    default_out = args.xml.parent / "clips"
    raw = input(f"\nWhere should the clips go? [{default_out}]: ").strip()
    args.out = Path(clean_dropped_path(raw)) if raw else default_out

    print("\nChecking the timeline before cutting anything...\n")
    args.manifest_only = True
    args.interactive = True


def cli_update() -> int:
    print(f"{NAME} {VERSION} — checking for an update ...")
    latest, err = fetch_latest()
    if err:
        # Said plainly rather than folded into "you are on the newest release". A failed
        # check is not good news and should not read like it.
        print(f"  Could not check: {err}")
        print(f"  Still on {VERSION}. Nothing was changed.")
        return 1
    info = newer_than_running(latest)
    if info is None:
        print(f"  You are on the newest release ({VERSION}).")
        return 0
    # The same version being offered back is the repair path, not a new release, and
    # saying "3.71 is available" to someone already running 3.71 reads as a bug.
    if str(info.get("version")) == VERSION:
        print(f"\n  {VERSION} is installed, but its Premiere panel was not finished last "
              f"time. Running the update again re-copies it.")
    else:
        print(f"\n  {info['version']} is available.")
    if info.get("notes"):
        print(f"  {info['notes']}")
    print(f"  Files: {', '.join(info.get('files') or UPDATE_FILES)}")
    if input("\nInstall it now? [Y/n]: ").strip().lower().startswith("n"):
        print("  Left alone.")
        return 0
    detail: dict = {}
    ok, msg = apply_update(info, out=detail)
    print(f"\n  {msg}")
    if ok:
        print("  Restart the tool to run the new code."
              if detail.get("restart_needed", True)
              else "  Nothing to restart — the next run uses the new code.")
        # ok:true still means the ENGINE is updated. When the panel copy failed it is not,
        # and that must not be left as a tail on a success line nobody reads to the end.
        if detail.get("panel_error"):
            print(f"  !! The Premiere panel was NOT updated: {detail['panel_error']}")
            print("     This check will keep offering the same version until it lands.")
    return 0 if ok else 1


def main():
    # LINE-buffer stdout. Python block-buffers into a pipe, which is exactly what the
    # Premiere panel gives this process — so every progress line sat in an 8 KB buffer and
    # arrived in one burst when the run ENDED. Measured on the fixture: the first per-clip
    # line reached the reader at 0.63s, the same instant the process exited. On a real
    # timeline that is minutes of a panel showing "Starting…" with no way to tell a slow
    # encode from a hung one, which is precisely how it was reported.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:      # noqa: BLE001 - older interpreter, or stdout replaced
        pass

    ap = argparse.ArgumentParser(
        description="Extract every cut of a Premiere Pro timeline from its FCP7 XML export.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("xml", type=Path, nargs="?", metavar="XML_OR_DUMP",
                    help="Final Cut Pro 7 XML exported from Premiere, or a .json "
                         "written by the panel (omit it to be walked through step by step)")
    ap.add_argument("--pick", type=Path, metavar="FILE",
                    help="cut only the clips listed in FILE, one per line as "
                         "'TRACKTYPE TRACKINDEX TIMELINEIN TIMELINEOUT' (e.g. "
                         "'video 1 448 536'). Three fields also work and mean any cut "
                         "starting there.")
    ap.add_argument("--panel", type=Path, metavar="DUMP.json",
                    help="overlay a panel dump on the XML: adds real speed-ramp "
                         "keyframes, repairs stale media paths, cross-checks both sources")
    ap.add_argument("-o", "--out", type=Path, default=Path("./clips"), help="output directory")
    ap.add_argument("--tracks", choices=["video", "audio", "all"], default="video",
                    help="which tracks to extract (default: video)")
    ap.add_argument("--remap", action="append", default=[], metavar="OLD=NEW",
                    help="rewrite source paths, e.g. /Volumes/Old=/Volumes/New (repeatable)")
    ap.add_argument("--sequence", metavar="NAME|N",
                    help="which sequence to cut, by name or 1-based index. When a "
                         "sequence's name is itself a number, say which you mean: "
                         "pos:N for the Nth sequence, name:NAME for the one named NAME")
    ap.add_argument("--list-sequences", action="store_true",
                    help="list the sequences in the XML and exit")
    # NO default here, deliberately. vcodec_of() supplies libx264 for every reader, and
    # leaving this None is what lets --export-preset below tell "the encoder was not given"
    # from "the encoder was given as libx264": with a default of "libx264" the stored
    # encoder never passed that loop's `in (None, "")` test, so a preset saved at H.265
    # loaded from a terminal exported H.264 without saying so. Same trap --container is
    # still special-cased for, one line further down.
    ap.add_argument("--vcodec", default=None, choices=["libx264", "libx265"],
                    help="video encoder. libx264 (H.264, default) plays everywhere; "
                         "libx265 (H.265/HEVC) is about half the size at the same crf "
                         "and slower. The crf scales differ: x265 28 ≈ x264 23.")
    ap.add_argument("--container", default="mp4",
                    help="output container: mp4 (default) or mov. Same video in both, "
                         "only the wrapper changes. Avoid mkv: it declares one frame "
                         "more than the file holds.")
    # --- export settings ------------------------------------------------------------
    ap.add_argument("--crf", type=float, metavar="N",
                    help="quality, 0-51, lower is bigger and better (default 1). "
                         "Fractional works (18.5). Do NOT use 0: it emits High 4:4:4 "
                         "Predictive, which will not play on a Mac.")
    ap.add_argument("--bitrate", metavar="RATE",
                    help="target an average bitrate instead of a quality (e.g. 8M, "
                         "5000k). Ignores --crf.")
    # Kept ONLY so an installed panel older than this release does not fail at argparse.
    # Whole-frame trimming is unconditional now; passing this changes nothing.
    ap.add_argument("--whole-frames", dest="whole_frames", action="store_true",
                    help="accepted and ignored — whole-frame trimming is always on")
    ap.add_argument("--render-audio", dest="render_audio", action="store_true",
                    help="keep the render's own sound in each Timeline Render clip instead of "
                         "stripping it. The panel mutes the audio tracks that were not ticked "
                         "before Premiere renders, so what is heard is what was chosen.")
    ap.add_argument("--render-dir", dest="render_dir", type=Path, metavar="DIR",
                    help="cut from PRE-RENDERED TIMELINE RANGES in DIR instead of the raw "
                         "source, so colour, titles, Motion, transitions and speed ramps "
                         "come out with the clip. Each file must be named "
                         "'TRACKTYPE-TRACKINDEX-TIMELINEIN-TIMELINEOUT.mp4'. A cut with "
                         "no render fails rather than falling back to its source.")
    ap.add_argument("--render-planned", dest="render_planned", action="store_true",
                    help="a SCAN flag, used with --manifest-only and refused on an export: "
                         "report the cut list as it will be once Premiere has rendered "
                         "it, so comps and offline clips are not marked uncuttable")
    # ⚠️ THE DEFAULT IS None, NOT 0, AND THE DIFFERENCE IS LOAD-BEARING. `0` is a real
    # answer — "number and keep every video track" — and the numbering below defaults an
    # UNANSWERED flag to the lowest track. With default=0 the two were the same value, so
    # giving the numbering a default silently removed the ability to ask for every track.
    # ⚠️ THE OMITTED CASE DIFFERS BY RUN, AND THE HELP USED TO SAY IT DID NOT. It read
    # "omitted, a render numbers the lowest video track that has cuts", but that default is
    # gated on `not args.render_dir` (see the numbering in main(), and CLAUDE.md's 3.87
    # notes for the four-cuts-three-files overwrite the gate prevents). So a --render-dir
    # export that names no track keeps and numbers EVERY video track — the gaps the old
    # sentence promised an omission avoids. Measured in tests/check_flags.py on V1 A 0-30,
    # V2 C 15-45, V1 B 30-60: omitted, B is 3; with --video-track 1, B is 2. On a real
    # six-track timeline the V1 files came out 01, 04, 06, 09, 12 … with every overlay cut
    # reported "no render".
    ap.add_argument("--video-track", dest="video_track", type=int, default=None,
                    metavar="N",
                    help="which video track defines the shots in a render — one track "
                         "supplies the cut list and everything above it is already in "
                         "the picture. 0 keeps every video track. Omitted, a "
                         "--render-planned scan numbers the lowest video track that has "
                         "cuts, but a --render-dir export keeps and numbers EVERY video "
                         "track, as 0 does; name the master track to get it cut alone, "
                         "numbered 01..N.")
    ap.add_argument("--audio", action="store_true",
                    help="write ONE mp3 for the whole timeline: the chosen audio tracks "
                         "at their timeline positions, gaps as silence, as long as the "
                         "sequence. Lands as _timeline_audio.mp3. Narrow it with "
                         "--audio-tracks.")
    ap.add_argument("--renumber", "--pick-renumber", dest="renumber", action="store_true",
                    help="number a narrowed run 01..N instead of keeping each clip's number "
                         "from the whole timeline. The default keeps them, so a re-export "
                         "of a few clips — or of one file type — replaces the files it meant "
                         "to replace instead of duplicating them under new numbers. "
                         "--pick-renumber is the old name and still works.")
    ap.add_argument("--audio-per-track", dest="audio_per_track", action="store_true",
                    help="write ONE audio file per chosen track instead of one mixed file: "
                         "_track_A2.mp3 and so on, each as long as the sequence with the "
                         "gaps as silence. Use it when what you want is the voice-over "
                         "whole, not ninety fragments. Narrow it with --audio-tracks.")
    ap.add_argument("--audio-tracks", dest="audio_tracks", metavar="LIST",
                    help="which audio tracks the mix reads, as timeline track numbers: "
                         "\"2\" for A2 alone, \"1,2\" for both, omitted for all. Only "
                         "meaningful with --audio.")
    ap.add_argument("--size-probe", dest="size_probe", action="store_true",
                    help="MEASURE the size estimate instead of modelling it, by encoding "
                         "about a second of each clip. Accurate to a few percent and much "
                         "slower. Without it the estimate comes from metadata alone.")
    ap.add_argument("--scale", type=float, metavar="PCT",
                    help="output resolution as a percentage of each source's own "
                         "(default 100). 50 turns 1080x1920 into 540x960. Frame count "
                         "is untouched. Both dimensions round down to even.")
    ap.add_argument("--x264-preset", dest="x264_preset", metavar="NAME",
                    help="libx264 speed/compression preset (default veryfast). Never "
                         "moves a frame.")
    ap.add_argument("--fps", type=float, metavar="N",
                    help="force an output frame rate. ⚠️ RESAMPLES: frames are dropped "
                         "or duplicated, and every affected cut is recorded "
                         "frame_exact=false. A cut already at this rate is untouched, and "
                         "so are stills, audio cuts and retimed cuts.")
    ap.add_argument("--export-preset", metavar="NAME",
                    help="load saved export settings by name (see --list-presets)")
    ap.add_argument("--save-preset", metavar="NAME",
                    help="save the settings used by this run under NAME")
    ap.add_argument("--list-presets", action="store_true",
                    help="list saved export presets and exit")
    # Machine-readable variants, for the panel. Same reason as --check-update-json: it
    # cannot import this module, so it shells out and reads JSON, which keeps ONE
    # implementation of where presets live and what they contain.
    ap.add_argument("--list-presets-json", action="store_true",
                    help="print saved export presets as JSON and exit")
    ap.add_argument("--delete-preset", metavar="NAME", help="remove a saved preset")
    ap.add_argument("--presets-only", action="store_true",
                    help="manage presets and exit, without needing an XML")
    ap.add_argument("--speed", choices=["native", "timeline"], default="native",
                    help="for speed-ramped clips: 'native' keeps the real source frames "
                         "(default); 'timeline' retimes to what played on screen")
    # DEFAULT IS None ON PURPOSE, because it is MODE-DEPENDENT and the engine only learns
    # the mode from its own arguments. Resolved in main(): "one-cut" when render mode is
    # active (--render-dir or --render-planned), "resolve" otherwise. An explicit --nest
    # always wins. Source mode ignores the choice entirely — a nest has no file to seek, so
    # one-cut there would only lose clips.
    # ⚠️ DEFAULT IS `ignore`, IN BOTH MODES, AND THAT IS A DECISION NOT AN OVERSIGHT.
    # "and ignore the transition just cut by the clip in out for me" — each cut is exactly
    # the clipitem's own <start>/<end> as Premiere wrote it. The cost was put to him in
    # plain terms — the two clips across a dissolve BOTH contain the blend, so neighbours
    # share those frames — and he chose it with the cost known. He was also offered
    # mode-scoped behaviour and a panel tick and declined both: source media and timeline
    # render behave identically.
    #
    # `split` keeps the old behaviour reachable, in the same hidden-not-deleted shape as
    # --vcodec libx265: the function and all of its tests stay, one argument away. He has
    # reversed this decision once already today, in both directions.
    # ⚠️ DEFAULT IS `drop`, AND IT CHANGES WHAT A RUN PRODUCES. A clipitem with
    # <enabled>FALSE</enabled> is a clip the editor switched OFF on the timeline — material
    # deliberately removed from the edit. This tool's whole premise is a dataset of
    # FINISHED edits, so shipping that material alongside what was kept, with the same
    # status and no way to tell them apart, corrupts the dataset silently. Measured before
    # this existed: a disabled clip exported as a ~1 MB file with status "ok".
    #
    # `keep` restores the old behaviour for anyone who wants the takes that were cut, and
    # says so in the warnings rather than leaving it to be discovered.
    ap.add_argument("--disabled", choices=["drop", "keep"], default="drop",
                    help="clips the editor DISABLED on the timeline: 'drop' (default) "
                         "leaves them out; 'keep' cuts them like any other clip")
    ap.add_argument("--transitions", choices=["split", "ignore"], default="ignore",
                    help="where a cross-dissolve makes two clips overlap: 'ignore' "
                         "(default) cuts each clip at its own in/out, so both hold the "
                         "blended frames; 'split' moves the boundary to the middle of the "
                         "overlap so no frame appears twice")
    ap.add_argument("--nest", choices=["one-cut", "resolve"], default=None,
                    help="what a nested sequence becomes in timeline-render mode: "
                         "'one-cut' treats the nest as a single clip (default in render "
                         "mode); 'resolve' cuts the clips inside it, from every inner "
                         "video track. Source-media mode always resolves and ignores this")
    ap.add_argument("--min-frames", type=int, default=1, help="skip cuts shorter than N frames")
    ap.add_argument("--ext", metavar="LIST",
                    help="only cut clips whose SOURCE file has one of these extensions, "
                         "comma separated: --ext mp4,mov (default: every type present)")
    ap.add_argument("--resume", action="store_true",
                    help="keep a clip already in the folder only when this tool recorded "
                         "writing that exact file for that cut at these settings; re-cut "
                         "the rest (pick a long run back up where it stopped)")
    ap.add_argument("--update", action="store_true",
                    help="check for a newer release and install it (asks first)")
    # Machine-readable variants, for the Premiere panel. It cannot import this module,
    # so it shells out and reads JSON — which keeps one implementation of the update
    # logic rather than a second one in JavaScript.
    ap.add_argument("--check-update-json", action="store_true",
                    help="print available-update info as JSON and exit")
    ap.add_argument("--self-update-json", action="store_true",
                    help="install the newest release, printing JSON progress, and exit")
    ap.add_argument("--no-probe", action="store_true", help="skip ffprobe technical specs")
    ap.add_argument("--manifest-only", action="store_true", help="write manifest, cut nothing")
    ap.add_argument("--dry-run", action="store_true", help="show what would happen")
    ap.add_argument("--timeout", type=int, default=1800, help="per-clip ffmpeg timeout (s)")
    args = ap.parse_args()

    if args.list_presets_json:
        # 3.93 audit: an unreadable presets.json is said, not shown as "no presets".
        _pr, _bad = load_presets_checked()
        print(json.dumps({"presets": _pr, "path": str(presets_path()),
                          **({"error": _bad} if _bad else {})}))
        return

    if args.delete_preset:
        saved, _bad = load_presets_checked()
        removed = saved.pop(args.delete_preset, None) is not None
        if removed:
            _write_presets(saved)
        if args.presets_only:
            print(json.dumps({"ok": removed, "deleted": args.delete_preset,
                              "presets": saved, **({"error": _bad} if _bad else {})}))
            return
        print(("removed" if removed else "no such preset:") + f" {args.delete_preset}"
              + (f" ({_bad})" if _bad else ""))

    # Saving a preset does not need a timeline. Without this, making one from the panel
    # would mean reading a sequence first, which is a strange thing to have to do to
    # record four numbers.
    if args.presets_only:
        if args.save_preset:
            try:
                save_preset(args.save_preset, preset_from_args(args))
            except PresetsUnreadable as e:
                print(json.dumps({"ok": False, "saved": None, "error": str(e),
                                  "presets": {}}))
                return 1
        print(json.dumps({"ok": True, "saved": args.save_preset,
                          "presets": load_presets()}))
        return

    if args.list_presets:
        saved, _bad = load_presets_checked()
        if _bad:
            print(f"The presets file cannot be read: {_bad}")
            return 1
        if not saved:
            print(f"No export presets yet. Make one with --save-preset NAME.")
            print(f"They live in {presets_path()}")
            return
        print(f"{len(saved)} export preset(s) in {presets_path()}:\n")
        for nm in sorted(saved):
            s = saved[nm]
            bits = [f"{k} {v}" for k, v in s.items() if v not in (None, "")]
            print(f"  {nm:22} {', '.join(bits) or '(defaults)'}")
        return

    # A preset supplies only what was NOT given explicitly, so a flag on the command line
    # always wins over the stored value — otherwise a preset would silently override the
    # thing you just typed.
    if args.export_preset:
        saved, _bad = load_presets_checked()
        if _bad:
            sys.exit(f"error: the export presets cannot be read — {_bad} — so "
                     f"{args.export_preset!r} cannot be loaded.")
        if args.export_preset not in saved:
            sys.exit(f"error: no export preset named {args.export_preset!r}. "
                     f"Try --list-presets.")
        for k, v in saved[args.export_preset].items():
            if v in (None, ""):
                continue
            if k == "container" and args.container != "mp4":
                continue          # an explicit --container wins
            if getattr(args, k, None) in (None, ""):
                setattr(args, k, v)
        print(f"  export preset: {args.export_preset}")

    if args.update:
        return cli_update()

    if args.check_update_json:
        latest, err = fetch_latest()
        print(json.dumps({
            "current": VERSION,
            "update": newer_than_running(latest),
            # `checked` is the field a front end must look at first. Without it, no
            # network and up-to-date were the same reply, and the panel said "nothing
            # newer published" to someone who had not reached GitHub at all.
            "checked": err is None,
            "error": err,
            "panel_dir": str(cep_extensions_dir() / PANEL_ID),
            "bundled": is_bundled_install(),
            "source_checkout": (install_dir() / ".git").exists(),
            # The version whose panel copy did not finish, if there is one. It is why
            # `update` can name the version already installed: this is a repair offer, not
            # a new release, and a front end that says so spares the user the confusion.
            "panel_repair": panel_repair_pending(),
        }))
        return

    if args.self_update_json:
        latest, err = fetch_latest()
        if err:
            print(json.dumps({"ok": False, "current": VERSION, "checked": False,
                              "message": err}))
            return
        info = newer_than_running(latest)
        if not info:
            print(json.dumps({"ok": False, "current": VERSION, "checked": True,
                              "message": f"already on {VERSION}; nothing newer published"}))
            return
        steps: list[str] = []
        detail: dict = {}
        ok, msg = apply_update(info, progress=steps.append, out=detail)
        print(json.dumps({"ok": ok, "current": VERSION, "checked": True,
                          "version": info.get("version"),
                          "message": msg, "steps": steps,
                          # True only when a PANEL file actually changed. A cut-logic-only
                          # release is live for the next export with no restart at all.
                          "restart_needed": detail.get("restart_needed", True),
                          "changed": detail.get("changed", []),
                          # ok true with panel_error set means the ENGINE updated and the
                          # panel did not — the one case where a success banner would be
                          # telling the editor to restart into a panel that is not there.
                          "panel_error": detail.get("panel_error")}))
        return

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"error: {tool} not found on PATH. Install it (macOS: brew install ffmpeg).")

    if args.xml is None:
        interactive_setup(args)
    if not args.xml.is_file():
        sys.exit(f"error: {args.xml} not found")

    # ⚠️ --out THAT IS AN EXISTING FILE ENDED IN A TRACEBACK, and only after the whole
    # scan summary had printed. Measured: `-o <a file>` printed the estimate, the warnings
    # and the missing-media list, then `FileExistsError: [Errno 17] File exists` out of
    # `args.out.mkdir(...)`, rc 1. Nothing was written either way, so this costs the user
    # nothing but a page of Python. Said here, before the read, because the answer does not
    # depend on anything the read finds out. The panel cannot reach this — it creates the
    # folder itself before spawning the engine — so this is the hand-typed CLI case.
    if args.out.exists() and not args.out.is_dir():
        sys.exit(f"error: --out {args.out} is a file, not a folder. Give a folder name — "
                 f"it is created if it does not exist.")

    # ⚠️ --render-planned ON AN EXPORT WROTE SOURCE PIXELS UNDER RENDER NAMES. The flag says
    # "a render is COMING", which is only true of a scan: cut_from_of() answers "render", so
    # the files are named on the timeline clock and the manifest records cut_from render —
    # and with no --render-dir there is no render, so run_cut encodes the camera file.
    # MEASURED on the fixture: 16 files, cut_from render, render_path empty on every row,
    # and clip 01's picture md5-identical to the source-mode export's. A later
    # `--render-dir … --resume` then matched all 16 by id and name ("16 already there") and
    # delivered camera originals as the edited clips. The help called the flag "meaningless
    # on an export"; it was worse than meaningless, so it is refused. The panel sends it
    # only with --manifest-only, which is untouched. The interactive walk-through is refused
    # too, because it scans with --manifest-only and then goes on to cut.
    if (getattr(args, "render_planned", False) and not getattr(args, "render_dir", None)
            and (getattr(args, "interactive", False)
                 or not (args.manifest_only or args.dry_run))):
        sys.exit("error: --render-planned describes a render that does not exist yet, so it "
                 "belongs on a scan (--manifest-only) and nowhere else. To cut from "
                 "Premiere's renders pass --render-dir DIR; to cut from the source media, "
                 "leave --render-planned off.")

    # ⚠️ A RUN THAT ENCODES NOTHING MAY NOT REPLACE THE RECORD OF ONE THAT DID. --dry-run and
    # --manifest-only both write manifest.json into -o, settings block included, and that
    # block is what --resume compares its own settings against. So previewing into the
    # export folder erased the evidence the next resume needed. MEASURED on the fixture,
    # exported at crf 40: `--dry-run --crf 18` into it, then `--resume --crf 18`, printed no
    # drift, ended "2 written … 17 already there" and kept the crf-40 files under a manifest
    # saying crf 18; `--manifest-only --scale 50` then `--resume --scale 50` kept 17 files at
    # 640x360 recorded as 320x180. Without the preview the same resume re-cut all 19. The
    # README's own example (`-o ./clips --manifest-only`) is the export's default folder.
    #
    # Refused rather than written somewhere else: a preview landing in a folder nobody named
    # is its own surprise. The panel is not affected — its scans go to their own folder and
    # it never sends --dry-run. The interactive walk-through's OWN --manifest-only scans
    # into the folder it is about to cut into, so that one is handled where the scan's
    # manifest is written, below; a --dry-run is refused there as everywhere, because the
    # "cut" it goes on to make encodes nothing and writes its manifest all the same.
    if (args.dry_run
            or (args.manifest_only and not getattr(args, "interactive", False))):
        _held = export_held_in(args.out)
        if _held:
            sys.exit(f"error: --out {args.out} already holds an export ({_held} encoded "
                     f"clip(s) in its manifest.json). "
                     f"{'--dry-run' if args.dry_run else '--manifest-only'} would replace "
                     f"that record with one describing no files, and a later --resume "
                     f"would then keep clips made at other settings. Point -o at another "
                     f"folder for the preview.")

    remaps = []
    for r in args.remap:
        if "=" not in r:
            sys.exit(f"error: --remap needs OLD=NEW, got {r!r}")
        old, new = r.split("=", 1)
        remaps.append((old, new))

    merge_notes: list[str] = []

    def show_sequences(rows):
        print(f"{len(rows)} sequence(s) in {args.xml.name}:\n")
        print(f"  {'#':>3}  {'name':40s} {'fps':>7s} {'duration':>12s} {'clips':>7s}")
        for s in rows:
            print(f"  {s['index']:>3}  {s['name'][:40]:40s} {s['fps']:>7g} "
                  f"{s['duration_tc']:>12s} {s['clip_count']:>7d}")

    # A panel dump describes exactly one sequence — the one that was open — so there is
    # nothing to list and nothing to pick.
    if DumpTimeline.looks_like_dump(args.xml):
        if args.list_sequences:
            tl = DumpTimeline(args.xml, remaps)
            print(f"1 sequence in {args.xml.name} (panel dumps hold only the open one):\n")
            print(f"  {'#':>3}  {'name':40s} {'fps':>7s} {'clips':>7s}")
            print(f"  {1:>3}  {tl.sequence_name[:40]:40s} {tl.sequence_fps:>7g} "
                  f"{len(tl.cuts):>7d}")
            return
        tl = DumpTimeline(args.xml, remaps)
        if args.panel:
            sys.exit("error: --panel overlays a dump onto an XML. This input is "
                     "already a dump.")
    else:
        if args.list_sequences:
            show_sequences(Timeline.list_sequences(args.xml))
            return
        # WHAT A NEST BECOMES, decided before the parse because _parse acts on it.
        #
        # Mode-dependent default: render mode gets one-cut (the render has every inner
        # layer in it already), source mode gets resolve (there is no render, and a nest has
        # no file of its own to seek — one-cut would just lose the clips). An explicit
        # --nest wins in render mode; source mode ignores it, which is what keeps every
        # existing source-mode run byte-identical.
        render_mode = bool(getattr(args, "render_dir", None)
                           or getattr(args, "render_planned", False))
        args.nest_effective = (args.nest or ("one-cut" if render_mode else "resolve"))
        nest_mode = ("one-cut" if render_mode and args.nest_effective == "one-cut"
                     else "all")
        args.nest_applied = nest_mode
        try:
            tl = Timeline(args.xml, remaps, args.sequence, nest_mode=nest_mode,
                          render_mode=render_mode)
        except SequenceChoice as e:
            show_sequences(e.options)
            sys.exit("\nerror: this XML holds more than one sequence — pick one with "
                     "--sequence NAME or --sequence N (name:NAME / pos:N when a name "
                     "is a number).")
        # Merged before filtering and naming, so a repaired path counts as present when
        # the missing-media report is built. The notes are held back and printed with
        # the rest of the summary rather than ahead of the header.
        #
        # Skipped entirely for an audio-only run: the dump's video clips would all
        # "match" cuts that the --tracks filter is about to discard, and reporting
        # 18 matches on a run that cuts one audio clip describes work nobody asked for.
        # The sequence's identity comes with any --panel, whatever --tracks does to the rest.
        if args.panel:
            tl.sequence_id = panel_sequence_id(tl, args.panel)
        if args.panel and args.tracks != "audio":
            merge_notes = overlay_dump(tl, args.panel)
        elif args.panel:
            merge_notes = ["--tracks audio: the panel overlay adds nothing to audio "
                           "cuts, so it was skipped"]

    # ⚠️ CLIPS THE EDITOR TURNED OFF, REMOVED BEFORE ANYTHING ELSE LOOKS AT THE LIST.
    #
    # Cut.enabled has been parsed from <enabled> since the beginning and had ZERO readers:
    # no filter, no status, no note, no column. So a clip switched off on the timeline came
    # out as a finished file with status "ok", indistinguishable from the take that
    # replaced it.
    #
    # Done here, ahead of the audio_items capture, so a disabled audio clipitem cannot feed
    # the voice-over mix either — a muted music bed reaching the mix is the same defect
    # wearing different clothes.
    _off = [c for c in tl.cuts if not c.enabled]
    args.disabled_found = len(_off)
    # ⚠️ THE TWO CAUSES COUNTED SEPARATELY, because they are different editing gestures and
    # only one of them is called "disabled" in the UI. A clip switched off on its own is
    # <enabled>FALSE</enabled> on the clipitem; a whole layer parked with the eye or the
    # mute is <enabled>FALSE</enabled> on the <track>. On the reviewer's real exports the
    # first has never once occurred and the second occurs in 6 of them, so a message that
    # only said "disabled clips" would describe the case that does not happen.
    args.disabled_off_track = sum(1 for c in _off if not c.track_enabled)
    args.disabled_off_clip = args.disabled_found - args.disabled_off_track
    args.disabled_dropped = 0
    if _off and getattr(args, "disabled", "drop") == "drop":
        tl.cuts = [c for c in tl.cuts if c.enabled]
        args.disabled_dropped = len(_off)
    elif _off:
        # ⚠️ KEPT ON PURPOSE, SO IT IS ON THE RECORD. This is the one direction that puts
        # material the editor removed INTO a dataset of finished edits, so it goes in the
        # warnings, which reach the manifest and the top of clips.csv, not just stdout.
        _names = sorted({c.clip_name or "(unnamed)" for c in _off})
        tl.warnings.append(
            f"--disabled keep: {len(_off)} clip(s) switched OFF on the timeline were cut "
            f"anyway: " + ", ".join(_names[:4])
            + (", …" if len(_names) > 4 else "")
            + ". The `enabled` column in clips.csv marks them")

    # Every clip the edit still HAS, taken before --tracks, --min-frames, --ext, --pick and
    # the render's master track narrow the list to this run's selection. It is how
    # FolderTidy.plan tells a file of a clip this run merely did not select — left
    # alone — from a file of a clip the edit no longer has, which is moved aside. After the
    # disabled drop on purpose: a clip switched off has left the edit as surely as a
    # deleted one. A superset is the safe direction: an id wrongly in here only leaves a
    # file where it was.
    args.timeline_cut_ids = {c.cut_id for c in tl.cuts if c.cut_id}

    # ⚠️ THE AUDIO ITEMS ARE KEPT even when --tracks drops them as outputs. They are the SOURCE
    # of the voice-over mix, and "should audio clipitems become files of their own" is a different
    # question from "what was playing over this shot". Taken before the filter, because after it
    # they are gone.
    # ⚠️ ONLY AUDIO FFMPEG CAN ACTUALLY OPEN. A Dynamic Link graphic with an audio lane is an
    # audio cut like any other here, and the per-clip path skips it correctly — but the mix
    # fed it to ffmpeg as an input and lost the WHOLE mp3 to "Invalid data found when
    # processing input". Measured on a real export: one .aegraphic on A3 and no timeline
    # audio at all, twice in one session, while thirteen clips wrote fine. One unreadable
    # input must not cost the other twelve.
    tl.audio_items = [c for c in tl.cuts
                      if c.track_type == "audio" and c.media_kind != "unsupported"]
    # ⚠️ AND THE AUDIO INSIDE NESTS THAT --nest one-cut COLLAPSED — Timeline Render's default,
    # and the panel never sends --nest. The one-cut clip itself is "unsupported" and was
    # filtered out just above, which took the nested voice-over out of the mix and its track
    # out of audio_tracks_available with it. See Timeline._nest_audio_for_mix. The same
    # --disabled rule as the cut list applies to them.
    _nest_audio = [c for c in (getattr(tl, "nest_audio_items", None) or [])
                   if c.media_kind != "unsupported"
                   and (c.enabled or getattr(args, "disabled", "drop") != "drop")]
    tl.audio_items += _nest_audio

    # ⚠️ PREMIERE'S EXPLODED AUDIO CHANNELS, COLLAPSED OUT OF THE OUTPUT LIST.
    #
    # One <track> per audio CHANNEL means a stereo track's every clipitem arrives TWICE.
    # MEASURED on a two-lane stereo fixture of three clips: the menu offered "A1 · 3 items"
    # and the run produced SIX cuts in three byte-identical pairs — six rows in the panel,
    # six selectors in the pick file, six files on disk. Nothing reads <sourcetrack>, so
    # both halves of a pair are the same full-width cut of the same source range.
    #
    # ⚠️ AFTER THE audio_items CAPTURE ON PURPOSE, AND IT IS NOT AN OVERSIGHT. The mix has
    # its own collapse (vo_contributions), keyed on the PART — path, source in, duration,
    # offset — not on the cut, so that a dual-mono clip routed to take only channel 2 of
    # its file keeps both parts. That guard is graded by a listening test: an exploded pair
    # must mix at the same level as one lane, not +6.02 dB, with no extra samples pinned at
    # 0 dBFS. Collapsing upstream of it would leave that test with nothing to catch and the
    # +6 dB defence unmeasured. So the mix still sees every lane and still collapses them
    # itself; this pass decides what gets WRITTEN.
    #
    # ⚠️ AND NOT INSIDE Timeline: the parse product is what the XML says — 9 lanes, one cut
    # each — which is what premiere_track_numbers' regression tests read, including the
    # tripwire that proves the two halves of a pair are distinguishable at all.
    #
    # Both the SCAN and the EXPORT come through here, so they collapse identically and
    # their cut_ids — assigned at parse time, above this — still line up.
    _lanes_kept, _lanes_merged = collapse_exploded_audio_lanes(tl.cuts)
    tl.cuts = _lanes_kept
    args.exploded_lanes_merged = len(_lanes_merged)
    args.exploded_lane_merges = _lanes_merged
    if _lanes_merged:
        # NAMED, WITH THE TRACK. A bare count reads like a bug report; the names say which
        # clips Premiere had written once per channel.
        _shown = sorted({f"{m['name']} on {m['track']}" for m in _lanes_merged})
        tl.warnings.append(
            f"{len(_lanes_merged)} audio cut(s) were Premiere's extra CHANNEL lanes of a "
            f"clip already in the list and were merged into it: "
            + ", ".join(_shown[:4]) + (", …" if len(_shown) > 4 else "")
            + ". One clipitem on one audio track is one cut")

    # WHICH of those tracks the mix may read. Parsed here, once, so every later reader sees a
    # set of ints rather than re-parsing a string — and an unknown number is dropped with a
    # warning rather than silently selecting nothing.
    try:
        want = parse_track_list(getattr(args, "audio_tracks", None))
    except ValueError as e:
        # ⚠️ REFUSED, NOT GUESSED. An unreadable list used to parse to the empty set, and the
        # empty set means "every track" — so --audio-tracks "2-3" mixed the music it was
        # written to exclude, with audio_tracks_requested [] and no warning at all.
        sys.exit(f"error: --audio-tracks {e}")
    # ⚠️ premiere_track, NOT track_index. The XML's lane ordinal is a per-CHANNEL index —
    # nine lanes for four tracks on the real export — so `have` used to advertise seven
    # tracks for a four-track timeline, and A2 and A3 named the two halves of one stereo
    # pair. track_index still owns render_name/pick_key/clipKey; this number is the one the
    # editor and the panel menu speak in.
    have = sorted({a.premiere_track for a in tl.audio_items})
    if want:
        missing = [n for n in sorted(want) if n not in have]
        if missing:
            tl.warnings.append(
                f"--audio-tracks names A{', A'.join(str(n) for n in missing)}, which this "
                f"timeline does not have (it has "
                + (", ".join(f"A{n}" for n in have) if have else "no audio tracks") + ")")
        tl.audio_items = [a for a in tl.audio_items if a.premiere_track in want]
    args.audio_tracks_used = sorted({a.premiere_track for a in tl.audio_items})
    # ⚠️ WHAT WAS ASKED FOR, kept apart from what was used. A filter that fails to apply reports
    # every track as "used" and so looks exactly like "all tracks were requested" — the two have
    # to be separate numbers for a verifier to tell them apart.
    args.audio_tracks_requested = sorted(want)
    # ⚠️ CUTS, AND THAT IS NOW THE HONEST NUMBER. This used to de-duplicate by
    # (source, timeline in, timeline out, source in) because both lanes of a stereo pair
    # were still in the list, and counting cuts reported "A2 · 4 items" for what Premiere
    # showed as two clips. The de-duplication made the MENU right and left the DELIVERY
    # doubled: "A2 · 3 items", tick it, six files. collapse_exploded_audio_lanes has
    # removed the extra lanes above, so the count of cuts and the count of clips Premiere
    # shows are the same number — and this is the number the panel's tick actually
    # produces, which is the property that was broken.
    #
    # ⚠️ DO NOT PUT THE SET BACK. Its key omits clip_name, the lane, the speed, the fader
    # and `enabled`, so it under-counts any pair of genuinely different audio clipitems
    # that happen to share one source range on one track — the menu would then promise
    # fewer files than the tick delivers, which is this defect mirrored.
    args.audio_tracks_available = []
    for n in have:
        args.audio_tracks_available.append(
            {"index": n,
             "items": sum(1 for a in tl.cuts
                          if a.track_type == "audio" and a.premiere_track == n)})
    # Carried on args because that is what every run_cut() call already takes. Not a module
    # global: two sequences in one process would then share one timeline's voice-over.
    args.vo_items = tl.audio_items
    if args.tracks != "all":
        tl.cuts = [c for c in tl.cuts if c.track_type == args.tracks]
    tl.cuts = [c for c in tl.cuts if c.duration_frames >= args.min_frames]
    # How many cuts the timeline has, before --ext and --pick take any away. Recorded so
    # the sheet can say what was LEFT OUT: `picked_count` on its own is always equal to the
    # final count, which answered nothing.
    args.cuts_before_filters = len(tl.cuts)
    # ⚠️ THIS MUST RUN BEFORE EVERY FILTER THAT CAN DROP AN INDIVIDUAL CUT — --ext and
    # --pick both — and it ran before neither, then before only --pick.
    #
    # pick_key is (track type, track index, timeline IN, timeline OUT). The SCAN writes
    # split ranges into the manifest, the panel builds its selectors from those, and the
    # export then matched them against ranges the split had not touched yet — so every cut
    # a transition had moved failed to match and was filtered away. Reported as "it miss
    # all the clip with transition", which is exactly that set.
    #
    # v3.53 moved it above --pick and stopped there. --ext has the identical shape and the
    # panel makes it differ between the two runs BY DESIGN: the scan passes no --ext, the
    # export passes one built from the ticked file-type chips (argsFor(dir, allTypes) in
    # panel/client/main.js). Filtering first hands the split a different set of NEIGHBOURS,
    # so it moves different boundaries — measured on a nest fixture as 3 of 12 cuts
    # diverging, e.g. the scan promising 0-95 where the export computed 0-100. The
    # render's FILENAME is built from those numbers on one side and looked up by them on
    # the other, so attach_renders found nothing, and run_cut refuses to fall back to
    # source: the cut was neither cut nor cut-from-source.
    #
    # Not moved above --tracks or --min-frames, and that is deliberate:
    #   --tracks removes whole track TYPES, and the split only ever looks at video cuts
    #     grouped per track — losing every audio cut cannot change a video boundary.
    #   --min-frames drops individual cuts and therefore HAS the same shape, but the panel
    #     never passes it (settingArgs() does not emit it), so both runs use the same
    #     default. Splitting first would also change which cuts a given --min-frames
    #     drops, which is a behaviour change rather than a fix.
    #
    # ⚠️ AND THE ORDERING ABOVE STAYS PUT even though the split is off by default. With
    # --transitions ignore the divergence cannot arise at all, but anyone passing
    # --transitions split must still get a scan and an export that agree, so the sequencing
    # this comment describes is load-bearing for that path and its regression test.
    if (getattr(args, "transitions", "ignore") == "split"
            and (getattr(args, "render_planned", False)
                 or getattr(args, "render_dir", None))):
        n_split = split_transition_overlaps(tl.cuts, tl.sequence_fps)
        args.transitions_split = n_split
        # ⚠️ SAID OUT LOUD, because "we looked at this and chose not to touch it" is a
        # different fact from "there was nothing here", and the editor is the only one who
        # can tell whether a stacked layer was meant to be stacked. These are overlaps with
        # no <transitionitem> at the boundary — a resolved nest's layers flattened onto one
        # track index, most often — and splitting them would have cut both clips short at a
        # point the edit never had. Until now the splitter did exactly that, silently, and a
        # test asserted it: see check_nested's "1-4 are STACKING" block.
        _skipped = int(getattr(split_transition_overlaps, "skipped_stacked", 0) or 0)
        args.transitions_skipped_stacked = _skipped
        if _skipped:
            tl.warnings.append(
                f"{_skipped} overlapping pair(s) were left alone because Premiere put no "
                f"transition at the boundary — stacked layers, not dissolves. Those clips "
                f"still share frames with each other, which is what the edit asked for")
        if n_split:
            # ⚠️ WHAT IT MOVED, NOT A CLAIM ABOUT THE WHOLE LIST. It used to end "— no two
            # cuts hold the same frame", which the run itself can contradict six lines
            # later: the split walks CONSECUTIVE pairs and leaves a boundary alone when
            # either side would come out shorter than a frame, so a cut contained inside
            # another survives it. On a fixture holding one contained cut the same console
            # printed "split 1 ... no two cuts hold the same frame" and then "2 pair(s) of
            # cuts share 30 frame(s)". (0 residual pairs on 91 real exports — Premiere does
            # not write that shape — so this is the sentence being wrong, not the split.)
            print(f"\n  split {n_split} cross-dissolve overlap(s) at the midpoint — "
                  f"neither side of those boundaries holds the other's frames now")

    # ⚠️ MARKED BEFORE --ext, NOT AFTER. This block used to sit ~65 lines below the --ext
    # filter, which reads `render_planned` — so the flag was ALWAYS False when the filter
    # ran, and two of that filter's three render-aware clauses were dead code. `attach_renders`
    # sits below it too, so `render_path` was empty there as well. The measured consequence in
    # render mode was severe: --render-planned offered 68 rows on one real timeline and
    # `--render-planned --ext mp4` delivered 19, silently deleting 49 rows that were all
    # `cuttable: true, "ready — from render"`. That is the reviewer's "nó ra đúng 6 vid" and
    # his 25 -> 22, neither of which he caused.
    #
    # Also no longer gated on `not render_dir`. A render IS planned on an export too; the
    # separate question of whether a render actually EXISTS is answered by `render_path`,
    # which attach_renders sets, and which run_cut still refuses to proceed without.
    if getattr(args, "render_planned", False) or getattr(args, "render_dir", None):
        for c in tl.cuts:
            if c.track_type == "video":
                c.render_planned = True
        # ⚠️ ORDERING CONTRACT WITH THE --ext FILTER BELOW, WHICH READS render_planned.
        # This marking must stay ABOVE it. It did not for at least three releases, and the
        # filter then deleted every render-mode row whose source extension was not ticked —
        # measured at 49 rows on one real timeline, all of them reported cuttable. The
        # filter re-checks the RESULT of this loop and refuses to run without it.

    # ⚠️ THE TIMELINE'S OWN RANGES, CAPTURED BEFORE ANYTHING NARROWS THE LIST. --ext and
    # --pick both rewrite tl.cuts in place with no copy kept, and _neighbour_on_disk exists
    # precisely because of that: it reads the render folder so a picked subset can still see
    # its neighbours. But a folder is not a timeline. A render left behind by an earlier edit
    # — a clip since moved, lifted or trimmed — still carries a filename that abuts this
    # cut's boundary, and its pixels are unrelated to the join, so the comparison returns a
    # hard "no" and a hard "no" is exactly the value the verdict needs to fire. Review
    # reproduced it twice: the same +1 render refused with a clean folder and REPAIRED, one
    # frame wrong at every frame, with one stale file present. The panel makes this easy to
    # hit — cleanRenders keeps _renders/ after a dirty run and asks the editor to delete it
    # by hand, and the next export renders into the same folder.
    #
    # So a disk neighbour must name a range the timeline actually has. Captured here because
    # this is the last point at which the full list still exists.
    args.timeline_ranges = {(c.track_type, int(c.track_index),
                             int(c.timeline_in_frames), int(c.timeline_out_frames))
                            for c in tl.cuts}
    # ⚠️ AND THE NUMBER EACH CLIP WOULD CARRY IN A FULL RUN, captured at the same point and
    # for a related reason. Not at parse time: the list there still holds every track and
    # every cut --tracks and --video-track are about to remove, so a clip the full export
    # calls 04 is 06 in it — measured. Here the list is exactly what an unpicked run would
    # number, which is the number a picked run has to reproduce.
    #
    # ⚠️ A CLIP THAT CANNOT PRODUCE A FILE DOES NOT CONSUME A NUMBER, and this is the OTHER
    # numbering complaint — the 3 Sep one, which is not the same bug as the 9 Sep one:
    #
    #   "cái số thứ tự ở phần 'raw' đang bị sai ở trong Sequence đấy luôn, nó nhảy lung tung
    #    số (mặc dù thứ tự xuất hiện vẫn đúng, nhg nó ko lần lượt là 1,2,3,... mà nó nhảy
    #    1,5,7,...)"
    #
    # MEASURED on a real reported sequence in source mode: 78 cuts, 47 written, and the
    # delivered folder ran 01, 03, 04, 09, 11, 14 … up to 78 — forty-seven files with
    # thirty-one holes in the sequence. Every hole is a Dynamic Link comp, a title or an
    # adjustment layer: media_kind "unsupported", which source mode can never decode. They
    # were taking a number each on the way past.
    #
    # ⚠️ media_kind ONLY — NOT source_exists. A file that is merely missing is a REPAIRABLE
    # failure: relink it and it delivers. If a missing source lost its number, relinking and
    # re-exporting would renumber everything after it and the repair would break the very
    # filenames it was meant to restore. So offline media keeps its place in the sequence and
    # only the structurally undeliverable are skipped.
    #
    # ⚠️ AND IT IS PER MODE, which is correct rather than a wrinkle: the same .aegraphic is
    # undeliverable in Source Render and perfectly deliverable in Timeline Render, where the
    # render supplies the pixels. The two modes write into different folders — raw/ and
    # edited/ — each with its own 01..N, so they were never one sequence to keep in step.
    #
    # ⚠️ AND IN TIMELINE RENDER THE MASTER TRACK DECIDES, WHICH IS THE OTHER HALF OF THE SAME
    # BUG AND WAS REPORTED SEPARATELY:
    #
    #   "phần edited nó vẫn đang bị nhảy STT e ạ, khi tool read thì thậm chí nó cũng đang read
    #    sai nữa, nó read lên tận 60, trong khi bên dưới ghi có 29 file sẽ đc export"  (17 Sep)
    #
    # MEASURED on the same reported sequence: 65 video cuts spread over SIX tracks — 29 on V1,
    # 27 on V3, the rest scattered — and a Timeline Render writes one file per cut on the
    # MASTER track only, because everything above it is IN the picture rather than a shot of
    # its own. All 65 were taking a number here and 36 of them were dropped ~70 lines below by
    # the --video-track filter, so 29 delivered files came out numbered 1, 4, 9, 11, 14 … 60.
    # His two numbers, exactly.
    #
    # ⚠️ render_planned IS NOT ENOUGH TO TEST. It is set a few lines above for EVERY video cut
    # in render mode, not just the master track's — so it answers "is this run a render", not
    # "will this cut become a file". The track is the question, and it has to be asked here
    # rather than at the filter, because by then the numbers are already assigned.
    _vt = int(getattr(args, "video_track", 0) or 0)
    _rmode = bool(getattr(args, "render_planned", False) or getattr(args, "render_dir", None))

    # ⚠️ AND WHEN NOBODY SAYS WHICH TRACK IS THE MASTER, THE FIRST READ IS THE ONE THAT PAYS.
    #
    # Reported 17 Sep, after the fix above had shipped in 3.86: "his first read still wrong",
    # with a list numbered to 60 under a footer promising 29 files — the same symptom, on a
    # sequence that had been read once. The panel only learns which video tracks exist FROM a
    # read (the menu is built from the scan's own manifest), so on the FIRST read of a session
    # state.vtrackWant is empty and --video-track is not sent at all. The flag arrives from the
    # second read onwards, which is why it looked fixed.
    #
    # So the default belongs here, where the numbering is: in render mode with no track named,
    # take the LOWEST video track that has numberable cuts — the same rule the panel's menu
    # uses for its own default, so the read and the export cannot disagree about it.
    #
    # NUMBERING ONLY. args.video_track is deliberately NOT written back: the filter ~70 lines
    # below reads it too, it is gated on --render-dir, and a CLI export that never named a
    # track must keep writing what it writes today. This changes which cuts take a NUMBER,
    # never which cuts become files.
    #
    # And it fires only when the flag was OMITTED. `--video-track 0` is a real answer meaning
    # "every video track", which is why the argument's default is None rather than 0.
    # Two clauses that were here are gone because nothing could tell them apart from their
    # neighbours: an `_rmode and` on this `if` (the skip below already asks, and the
    # source-mode check in check_render_mode.py is what proves that one), and a
    # render_planned/media_kind filter on the track list (in render mode render_planned is
    # set for EVERY video cut a few lines above, so it selected nothing). A clause no test
    # can fail is a claim nobody can check.
    #
    # ⚠️ AND IT IS GATED ON THERE BEING NO --render-dir, BECAUSE THE FILTER IS WHAT MAKES A
    # DEFAULT SAFE. The filter ~70 lines below reads args.video_track itself, and for an
    # OMITTED flag that is 0 — "keep every video track". So on an export it keeps all of
    # them while this would have numbered only the lowest: every cut off that track is
    # written, carrying index 0, and two of them sharing a timeline range and a source name
    # resolve to the SAME filename. Measured on a three-track fixture: four cuts, three
    # files, one shot lost to an overwrite, and a --resume rerun then reporting
    # "1 written, 0 failed … 3 already there" over the folder that was missing it. 3.86
    # numbered the same four 01..04.
    #
    # A scan has no filter to disagree with — it reports every row either way — so the
    # default does its job there, which is the first read this exists for. An export that
    # named no track keeps doing exactly what it did in 3.86: every video track numbered,
    # every video track written. That is also what this block's own comment above promises
    # ("a CLI export that never named a track must keep writing what it writes today"),
    # and without this gate it was the one thing it did not do.
    _vtracks = sorted(set(int(_c.track_index) for _c in tl.cuts
                          if _c.track_type == "video"))
    if (getattr(args, "video_track", None) is None
            and not getattr(args, "render_dir", None)):
        if _vtracks:
            _vt = _vtracks[0]

    # ⚠️ A TRACK THAT WAS NAMED BUT HOLDS NO CUTS ZEROED EVERY ROW, SILENTLY. The skip below
    # gives 0 to every video cut that is not on _vt, and nothing asked whether _vt had any.
    # MEASURED: --render-planned --video-track 2 on the repo fixture, whose 19 video cuts all
    # sit on V1, came back with all 19 at index 0, every name 00_…, every row "ready — from
    # render", and no word about track 2 anywhere.
    #
    # The panel reaches it: the menu's choice is remembered across sessions and sent on the
    # FIRST read, before that read has said which tracks exist. So a V2 left over from
    # another project lists every row unnumbered; the menu then corrects itself to the
    # lowest track that exists and the export numbers the files 01..N — the read and the
    # folder disagreeing, which is the numbering class reported three times already.
    #
    # On a SCAN it falls back to the lowest video track with cuts — the default an omitted
    # flag gets above, and the track the panel's menu lands on — so the read shows the
    # numbers the export will write. On an EXPORT it only says so: the --render-dir filter
    # reads args.video_track itself and leaves every video cut out, and quietly exporting a
    # different track than the one asked for is not this block's call to make. Same gate as
    # the default, for the same reason.
    if _rmode and _vt and _vtracks and _vt not in _vtracks:
        _have = ", ".join(f"V{t}" for t in _vtracks)
        if not getattr(args, "render_dir", None):
            tl.warnings.append(
                f"--video-track {_vt} names a track with no clips on this timeline "
                f"(video tracks here: {_have}) — numbered V{_vtracks[0]}, the lowest, "
                f"instead")
            _vt = _vtracks[0]
        else:
            tl.warnings.append(
                f"--video-track {_vt} names a track with no clips on this timeline "
                f"(video tracks here: {_have}) — no video clip is on it, so none will be "
                f"exported")

    _n = 0
    for _c in tl.cuts:
        if (_rmode and _vt and _c.track_type == "video"
                and int(_c.track_index) != _vt):
            # Another track's picture. The render composites it INTO the master track's
            # frames; it is never a file of its own, so it takes no number.
            _c.timeline_index = 0
        elif _c.render_planned or _c.media_kind != "unsupported":
            _n += 1
            _c.timeline_index = _n
        else:
            _c.timeline_index = 0
    # The biggest number the WHOLE timeline hands out, kept before --ext and --pick narrow
    # the list: a narrowed run that keeps these numbers has to pad them to the same width
    # the full run did, or 42 is written beside 042. See assign_output_names.
    _timeline_top = _n

    if args.ext:
        # ⚠️ THE GUARD, AND IT CHECKS THE FACT RATHER THAN A FLAG. An earlier version of
        # this stamped a boolean in the marking loop and tested that; moving the loop below
        # the filter while leaving the stamp behind satisfied it, which is precisely the
        # class of thing a guard exists to catch. So it asks the cuts themselves: in render
        # mode, a video cut list with nothing marked means the marking has not run yet, and
        # continuing would delete every row whose source extension is not ticked.
        _rmode = bool(getattr(args, "render_planned", False)
                      or getattr(args, "render_dir", None))
        _vids = [c for c in tl.cuts if c.track_type == "video"]
        if _rmode and _vids and not any(c.render_planned for c in _vids):
            sys.exit("internal error: the --ext filter ran before render_planned was "
                     "marked and would delete render-mode cuts. Move the marking loop "
                     "back above the filter.")
        # Filtered BEFORE the indices are assigned, so a run limited to one type gets a
        # clean 01..N rather than gaps where the other types used to be.
        want = {e.strip().lower().lstrip(".") for e in args.ext.split(",") if e.strip()}
        args.types_kept = sorted(want)
        before = len(tl.cuts)
        # TWO exemptions, and both of them fire. There were three; the third was
        # `c.render_path`, which attach_renders sets — and attach_renders runs BELOW this
        # filter, so it was empty here on every run that has ever executed. It is gone.
        #
        # ⚠️ THE PATTERN WORTH REMEMBERING: a defensive clause that cannot fire is
        # indistinguishable from a working one, so it protects nothing AND it makes the
        # comment above it false. This filter went on deleting cuts for three releases with
        # a comment explaining why it did not.
        #
        #   render_planned  — a render-mode row. The pixels come from Premiere, so a SOURCE
        #                     extension names a file that is not being read. Live only
        #                     because the marking loop above runs first; see the guard.
        #   not source_path — an adjustment layer, an EG title, a synthetic (Black Video, a
        #                     colour matte). Path("").suffix is "", which is in no --ext
        #                     set, so these were deleted by an extension test they could
        #                     never satisfy.
        tl.cuts = [c for c in tl.cuts
                   if getattr(c, "render_planned", False)
                   or not c.source_path
                   or Path(c.source_path).suffix.lower().lstrip(".") in want]
        print(f"  --ext {','.join(sorted(want))}: kept {len(tl.cuts)} of {before} cuts")

    if args.pick:
        # Also before indices are assigned, for the same reason --ext is: a run limited
        # to a handful of clips should number them 01..N, not leave gaps.
        #
        # Selectors are read from a FILE rather than the command line because a long
        # timeline is hundreds of clips and that is a lot of argv. One per line:
        #
        #     video 1 448 536    track type, track index, timeline in and out, in frames
        #
        # Matching on the geometry rather than an index, because an index depends on what
        # else was filtered and would silently select the wrong clip. The OUT-POINT is in
        # there because two cuts under a cross-dissolve share an in-point — see pick_key().
        want_keys = read_pick_file(args.pick)
        before = len(tl.cuts)
        tl.cuts = [c for c in tl.cuts if pick_matches(c, want_keys)]
        args.picked = len(tl.cuts)
        # Remembered for the "nothing to cut" exit far below: a pick file written against
        # an older cut list is the one way a healthy timeline full of clipitems ends the
        # run with no cuts, and the generic hint sends the reader to --tracks instead.
        args.pick_emptied = bool(before and not tl.cuts)
        print(f"  --pick: kept {len(tl.cuts)} of {before} cuts")
        missing = unmatched_picks(want_keys, tl.cuts)
        if missing > 0:
            print(f"  !! {missing} selection(s) in {Path(args.pick).name} matched no clip "
                  f"— the timeline may have changed since it was written")

    if getattr(args, "render_dir", None):
        # BEFORE indices are assigned, for the same reason --pick is: a run limited to one
        # track should number its clips 01..N rather than leave gaps where V2 used to be.
        want = int(getattr(args, "video_track", 0) or 0)
        before = len(tl.cuts)
        tl.cuts = [c for c in tl.cuts
                   # Audio cuts pass through untouched: the master-track choice is about which
                   # PICTURE Premiere renders, and audio clips are cut from their own source in
                   # every mode. Filtering them here is why a Timeline Render could never carry
                   # the per-track audio files — they were gone before attach_renders ran.
                   if c.track_type == "audio"
                   or (c.track_type == "video" and (not want or int(c.track_index) == want))]
        dropped = before - len(tl.cuts)
        matched, missing = attach_renders(tl.cuts, Path(args.render_dir))
        args.render_matched = matched
        args.render_missing = len(missing)
        print(f"\n  --render-dir: {matched} of {len(tl.cuts)} cut(s) have a render"
              + (f" ({dropped} not on video track {want} left out)" if dropped else ""))
        # Said, because nothing did: an export that named no master track is the one
        # render run whose numbering is not 01..N on that track, and the panel always
        # names one, so only a hand-typed command lands here.
        if getattr(args, "video_track", None) is None:
            _vts = sorted({int(c.track_index) for c in tl.cuts if c.track_type == "video"})
            if len(_vts) > 1:
                print(f"  ++ no --video-track given, so every video track is numbered and "
                      f"cut (V{', V'.join(str(t) for t in _vts)}). Pass --video-track "
                      f"{_vts[0]} to cut the master track alone, numbered 01..N")
        if missing:
            # Named, not counted. "3 cuts have no render" sends you looking through the
            # whole timeline; the filenames say exactly which ranges Premiere skipped.
            print(f"  !! {len(missing)} cut(s) have no render and will NOT be cut from "
                  f"their source instead:")
            for c in missing[:10]:
                print(f"       {render_name(c)}  {c.clip_name}")
            if len(missing) > 10:
                print(f"       ... and {len(missing) - 10} more")

    # ⚠️ A PICKED RUN KEEPS THE NUMBERS THE FULL TIMELINE GAVE IT. Renumbering 01..N was a
    # deliberate choice once — "a run limited to a handful of clips should number them 01..N,
    # not leave gaps" — and the team lead has since given the case it gets wrong, which is the
    # commoner one: "a bỏ tick hết các file khác, chỉ tick 1 vài files, thì a muốn mấy file đó
    # phải giữ nguyên được số thứ tự. Như hiện tại a chỉ tick 1 file thì nó nhảy số thứ tự về
    # 1, tính ra lại thành sai nếu như a chỉ muốn export lại file đó" (9 Sep).
    #
    # He is right, and the reason is that --pick is what the panel sends when you tick a
    # subset — which you do to RE-EXPORT clips that already exist. A re-export that renumbers
    # cannot replace the file it was meant to replace: clip 07 comes back as 01 and now there
    # are two of it. Numbering fresh is right for a first export of a subset and wrong for a
    # repair, and a repair is what the tick is for.
    #
    # ⚠️ --ext IS INCLUDED, and excluding it was wrong. The first cut of this reasoned that
    # --ext "selects by file TYPE rather than naming clips, so it has no 'these specific ones
    # again' meaning to preserve". That is true of the flag and false of the workflow: the
    # panel's file-type chips ARE --ext, so unticking .png and .aegraphic is how an editor
    # narrows an export, and it renumbered everything left.
    #
    # MEASURED on the real client export it was reported from: a full run numbers two of its
    # clips 33 and 58, and with only one file type ticked the same clips come out 15 and 27 —
    # the exact numbers on the screenshot. Same complaint as --pick, through a different flag.
    _narrowed = bool(getattr(args, "pick", None)) or bool(getattr(args, "ext", None))
    _keep_numbers = _narrowed and not getattr(args, "renumber", False)
    # ⚠️ THE WIDTH TRAVELS WITH THE NUMBER. Keeping 42 is only half of replacing the file:
    # the full run wrote it as 042 on a 100+ clip timeline, and a pick of rows under 100
    # padded to 2. A renumbered run is a fresh 01..N and pads from its own list, as before.
    # On args so run_cut's one-cut fallback naming pads the same way the batch pass did.
    args.index_pad_to = _timeline_top if _keep_numbers else 0
    # ⚠️ BOTH BRANCHES SKIP THE UNDELIVERABLE, so a narrowed run and a full run cannot
    # disagree about what a number means. timeline_index already carries the skip; the
    # renumbering branch re-applies the same rule rather than counting rows.
    _seq = 0
    for c in tl.cuts:
        if _keep_numbers:
            c.index = c.timeline_index
        elif c.timeline_index:
            _seq += 1
            c.index = _seq
        else:
            c.index = 0
        # PER CUT, and it compares rates rather than reading the flag. --fps 30 on a
        # 30 fps source emits no -r and keeps every frame.
        # ⚠️ PROVISIONAL. cut.source_fps is still the XML's DECLARED <rate> here, and
        # apply_probe() replaces it with ffprobe's further down — so this pass can decide
        # against a rate the encode will never see. Interpret Footage ("assume this frame
        # rate") makes Premiere declare a rate that is deliberately not the file's, and
        # VFR media differs routinely. Recomputed after the probe; see below.
        c.frame_exact = (not records_a_rate(c)
                         or not forced_rate_resamples(c, args, tl.sequence_fps))

    # ⚠️ THE COST OF --transitions ignore, ON THE RECORD AS A NUMBER. Measured on the final
    # cut list, after every filter, so it describes the folder that is about to be written
    # rather than some earlier version of it. Stated as a fact, not a warning: he asked for
    # the clips' own in/out points knowing the two sides of a dissolve would share frames.
    # ⚠️ THE INVARIANT, CHECKED ON EVERY RUN RATHER THAN IN A TEST. pick_key's own docstring
    # claims "a cut cannot both start and end where another one does without being that cut",
    # and that claim was false nine times in one real run before the de-duplication above.
    # It was ALSO measured as 0 on a different real timeline, which is exactly why this is
    # computed here and not asserted on one fixture: the shape that breaks it is data the
    # test author did not have.
    #
    # De-duplication removes every collision whose two cuts were identical. What it CANNOT
    # remove is two GENUINELY DIFFERENT cuts sharing a range — a title stacked over a shot
    # for exactly the same frames. Those keep both cuts, because both hold real pixels, and
    # they are reported rather than quietly collapsed: they share a render filename and, in
    # the panel, one row.
    _pk = {}
    for _c in tl.cuts:
        _pk[pick_key(_c)] = _pk.get(pick_key(_c), 0) + 1
    args.duplicate_pick_keys = sum(v - 1 for v in _pk.values() if v > 1)
    if args.duplicate_pick_keys:
        _names = sorted({c.clip_name for c in tl.cuts
                         if _pk.get(pick_key(c), 0) > 1})
        tl.warnings.append(
            f"{args.duplicate_pick_keys} cut(s) share a (track, in, out) identity with "
            f"a different cut: "
            + ", ".join(_names[:4]) + (", …" if len(_names) > 4 else "")
            + ". All kept, but they share a render filename and one row in the panel")
    args.overlap_pairs, args.overlap_frames = overlapping_cut_frames(tl.cuts)
    if args.overlap_pairs:
        # ⚠️ THE ADVICE IS ONLY ADVICE WHEN THE FLAG IS OFF. Counted AFTER the split above,
        # so with --transitions split these pairs are what SURVIVED it — and telling the
        # reader to pass a flag they already passed sends them looking for a mistake they
        # did not make. The split is also gated on render mode (see its call site): in
        # source mode it never runs, which is where a run with the flag set still reports
        # every pair. Measured on a four-clip fixture with a contained cut: source mode
        # printed 3 pair(s) under a flag that had done nothing, render mode printed 2
        # after splitting 1.
        if getattr(args, "transitions", "ignore") != "split":
            _advice = ("--transitions split moves each boundary to the middle of the "
                       "overlap")
        elif (getattr(args, "render_planned", False)
                or getattr(args, "render_dir", None)):
            # The same predicate the split's own call site uses, not the number of
            # boundaries it moved: it can legitimately move none and still be the reason
            # these pairs are here.
            _advice = ("these are what --transitions split left: it moves the boundary "
                       "between CONSECUTIVE cuts, and leaves one alone when either side "
                       "would come out shorter than a frame")
        else:
            _advice = ("--transitions split is already set, but it only moves boundaries "
                       "in render mode — in source mode each cut is the clipitem's own "
                       "in/out")
        tl.warnings.append(
            f"{args.overlap_pairs} pair(s) of cuts share {args.overlap_frames} frame(s) "
            f"in total (cross-dissolves). " + _advice)

    # ⚠️ NAMED, NOT DROPPED, and that is the measured half of this. A clip parked past the
    # sequence's declared end is normally an outtake pushed off the end of the edit — but
    # <duration> is not an end-of-edit marker in every context: in one real export a nested
    # sequence declares 242 frames while its own enabled content runs to 444, so a bound
    # that DROPPED these would delete finished material wherever that shape is reached.
    # Nothing compared the two before this, so a 500-560 outtake on a 300-frame sequence
    # was delivered as a numbered clip of the edit with warnings [].
    if tl.sequence_duration_frames > 0:
        _past = [c for c in tl.cuts
                 if c.timeline_in_frames >= tl.sequence_duration_frames]
        _parked = sorted({c.clip_name for c in _past})
        if _past:
            tl.warnings.append(
                f"{len(_past)} cut(s) start after the sequence's declared end "
                f"({frames_to_tc(tl.sequence_duration_frames, tl.sequence_fps)}) — parked "
                f"past the edit rather than in it, and cut anyway: "
                + ", ".join(_parked[:4]) + (", …" if len(_parked) > 4 else ""))

    print(f"{NAME} {VERSION}")
    print(f"  sequence : {tl.sequence_name}  @ {tl.sequence_fps:g} fps")
    print(f"  duration : {frames_to_tc(tl.sequence_duration_frames, tl.sequence_fps)}")
    print(f"  cuts     : {len(tl.cuts)}  across {len({c.source_path for c in tl.cuts})} source files")
    if getattr(args, "disabled_found", 0):
        _n = args.disabled_found
        _bits = []
        if getattr(args, "disabled_off_clip", 0):
            _bits.append(f"{args.disabled_off_clip} switched off individually")
        if getattr(args, "disabled_off_track", 0):
            _bits.append(f"{args.disabled_off_track} on tracks switched off")
        print(f"  disabled : {_n} clip(s) switched off on the timeline"
              + (f" ({', '.join(_bits)})" if len(_bits) > 1 else "")
              + (" were NOT cut — --disabled keep to include them"
                 if args.disabled_dropped else " were CUT ANYWAY (--disabled keep)"))
    nested = sum(1 for c in tl.cuts if c.nested_from)
    if nested:
        names = sorted({c.nested_from for c in tl.cuts if c.nested_from})
        print(f"  nested   : {nested} cut(s) resolved out of {len(names)} nested "
              f"sequence(s): {', '.join(names)}")
    reversed_n = sum(1 for c in tl.cuts if c.reversed)
    if reversed_n:
        print(f"  reversed : {reversed_n} cut(s) play backwards")
    if tl.markers:
        print(f"  markers  : {len(tl.markers)}")
    print(f"  encode   : {describe_encode(args, tl.cuts)}")
    # ⚠️ NOT EVERY WARNING IS A COMPLAINT. `!!` is the file's alarm marker and it belongs on
    # the ones that mean something went wrong; a timeline carrying titles produces the
    # no-media line on every single export, and under `!!` a normal run of a normal sequence
    # read as 31 things having broken. The advisory ones say what a clip IS and which mode
    # produces it, so they print under `++`, which this file already uses for the
    # "nothing was resampled" note. The manifest keeps one warnings list either way — the
    # marker is how the CONSOLE ranks them, not a second class of record.
    for w in tl.warnings:
        print(f"  {'++' if is_advisory_warning(w) else '!!'} {w}")
    # ⚠️ THIS IS NOT THE LAST WARNING THAT WILL EXIST. Five places append to tl.warnings
    # AFTER this loop has run — the probe pass, the shifted-render pass, the interpreted
    # rate, the VFR gap, the --resume settings drift — and every one of them was landing
    # in manifest.json and NOWHERE ELSE. Measured: a sentinel appended after this point
    # reached the manifest 1/1 and the console 0/1. Two of those five are about the
    # pixels being wrong, which makes the console the one place they had to appear.
    # The tail is flushed below, once, before either path writes its manifest.
    _warned_upto = len(tl.warnings)
    if getattr(args, "fps", None):
        # Loud, and not buried among the other warnings: this is the one setting that
        # changes what the files CONTAIN rather than how big they are.
        # ⚠️ COUNTED, not assumed. It used to say "every cut is recorded with
        # frame_exact=false" whatever the rates were, which now contradicts the manifest
        # it is describing — and on a matched rate the warning was pure alarm about an
        # export that changes nothing.
        _resampled = [c for c in tl.cuts if not c.frame_exact]
        if _resampled:
            print(f"\n  !! OUTPUT RESAMPLED to {float(args.fps):g} fps: {len(_resampled)} "
                  f"of {len(tl.cuts)} cut(s) drop or duplicate frames and are recorded "
                  f"frame_exact=false.")
        else:
            print(f"\n  ++ --fps {float(args.fps):g} matches every cut, so nothing is "
                  f"resampled and the cuts stay frame exact.")
    for n in merge_notes:
        print(f"  ++ {n}")

    if not tl.cuts:
        # The pick file is checked first because it is the only filter that can empty a
        # timeline the reader can SEE is full: the run has already printed "--pick: kept 0
        # of 21 cuts" and named the unmatched selections, and then sent them to --tracks
        # and to "confirm the XML contains clipitems", neither of which is the problem.
        if getattr(args, "pick_emptied", False):
            sys.exit(f"No cuts left: nothing in {Path(args.pick).name} matches a clip on "
                     f"this timeline. The selections were written against a different cut "
                     f"list — read the timeline again and re-tick.")
        sys.exit("No cuts found. Check --tracks, or confirm the XML contains clipitems.")

    if not args.no_probe:
        cache: dict = {}
        _ptimeout = getattr(args, "timeout", PROBE_READ_TIMEOUT)

        # ⚠️ THE PROBES RUN TOGETHER; EVERYTHING THEY CHANGE STILL RUNS ONE AT A TIME.
        #
        # This loop was the whole cost of a read. MEASURED on a real 24-cut timeline whose
        # 20 distinct sources live on a Google Drive mount, every file already warm:
        # 1.60 s with probing against 0.10 s with --no-probe — 94% of the read, spent
        # waiting on ffprobe one file after another. The same 20 through a pool of 8: 5.5x
        # faster. A cold Drive file costs seconds rather than the 0.1 s a warm one does, so
        # the first read of a session — the one the editor actually waits on, and the one
        # reported as "the first run is really slow" — pays the worst of it.
        #
        # ⚠️ ONLY THE FETCH IS PARALLEL. apply_probe() writes to the Cut, and a Cut is
        # touched by several passes that assume they are alone; the trimming arithmetic
        # inside it is exactly the code this project has been bitten by twice. So the pool
        # does nothing but fill the cache — one entry per DISTINCT source path, which is
        # what apply_probe would have keyed anyway — and the existing loop then runs
        # unchanged, single-threaded, in timeline order. Given the same media the two
        # produce byte-identical manifests; check_delivery.py asserts that rather than
        # taking it on trust.
        #
        # probe() catches everything it can raise and returns {"_probe_failed": …}, so a
        # worker cannot bring the pool down, and a source that fails here fails identically
        # to how it failed serially. The guard matches apply_probe's own first line: a cut
        # whose media is not there is not probed, by either route.
        #
        # The per-file timeout is unchanged and is now the worst case for a BATCH rather
        # than for the run: unreachable media used to cost N x --timeout in series.
        _ppaths: list[str] = []
        _pseen: set[str] = set()
        for c in tl.cuts:
            if c.source_exists and c.source_path and c.source_path not in _pseen:
                _pseen.add(c.source_path)
                _ppaths.append(c.source_path)
        if len(_ppaths) > 1:
            with ThreadPoolExecutor(max_workers=JOBS) as _pex:
                for _pp, _pd in zip(_ppaths,
                                    _pex.map(lambda q: probe_source(q, _ptimeout),
                                             _ppaths)):
                    cache[_pp] = _pd

        # Unchanged, and deliberately so: every cache entry it needs is already there, and
        # anything the pre-warm skipped still falls through to its own probe() call.
        for c in tl.cuts:
            apply_probe(c, cache, _ptimeout)
        # ⚠️ SAID ONCE, AT THE TOP, the way the --resume and ramp lines already are. A probe
        # failure is not a property of one clip — it is a property of a SOURCE FILE, so it
        # hits every cut that reads that file at once, and on a cloud-backed share it can hit
        # every cut in the run. Without this line the only trace was a per-clip error the
        # reader meets one at a time, after the export has already spent its time.
        _unread = sorted({Path(c.source_path).name or c.source_path
                          for c in tl.cuts if c.probe_error})
        if _unread:
            _why = next(c.probe_error for c in tl.cuts if c.probe_error)
            tl.warnings.append(
                f"{len(_unread)} source file(s) could not be read by ffprobe ({_why}) — "
                f"their media columns are blank and every cut from them is refused: "
                + ", ".join(_unread[:4]) + (", …" if len(_unread) > 4 else ""))
        # ⚠️ RE-DECIDED HERE, AND THIS IS THE PASS THAT COUNTS. apply_probe has just
        # replaced every declared rate with the measured one, and build_command runs later
        # still — so a flag decided before this point could disagree with the command built
        # after it about the same cut. Measured: an XML declaring 30 fps for 24 fps media,
        # exported at --fps 30, was recorded frame_exact=true beside source_fps 24.0 while
        # the encode emitted `-r 30` and duplicated 12 of 60 frames.
        for c in tl.cuts:
            c.frame_exact = (not records_a_rate(c)
                             or not forced_rate_resamples(c, args, tl.sequence_fps))
        # OPT-IN. Encoding a second of every clip is the accurate way to size an export and
        # it is the slow way: on the fixture a scan goes 0.21s -> 0.99s, and on media behind
        # Google Drive it is far worse. The default is estimate_bps(), which reads metadata,
        # costs nothing and lets a slider update live. --size-probe buys accuracy when the
        # export is big enough to be worth a wait.
        if getattr(args, "size_probe", False):
            if (getattr(args, "render_planned", False)
                    or getattr(args, "render_dir", None)):
                # Said out loud rather than silently skipped: a tick that stopped costing
                # a minute should not look like a tick that stopped working.
                print("\n  --size-probe does nothing in render mode: sizes are priced "
                      "from the sequence")
            probe_sizes(tl.cuts, args, tl.sequence_fps)
        # After probing, because the crf estimate scales the SOURCE's own bitrate. The
        # print lives here rather than in the header block above for the same reason —
        # up there the estimate is always zero, which is how the first version shipped.
        args.sequence_width = getattr(tl, "sequence_width", 0)
        args.sequence_height = getattr(tl, "sequence_height", 0)
        args.sequence_fps = tl.sequence_fps
        estimate_sizes(tl.cuts, args)
        est = sum(c.estimated_bytes for c in tl.cuts)
        if est:
            capped = parse_bitrate(getattr(args, "bitrate", None) or "")
            print(f"  size     : "
                  + (f"at most ~{human_bytes(est)} total (a ceiling)" if capped
                     else f"~{human_bytes(est)} total (estimate)"))

    # ⚠️ AFTER THE PROBE, NOT BEFORE IT — and the order is the whole fix. This block used to run
    # while cut.source_fps was still the XML's DECLARED <file><rate>, which apply_probe()
    # then replaced. Premiere writes 23/29/59 with <ntsc>FALSE for 23.976/29.97/59.94 media
    # (and "Interpret Footage" declares whatever the editor typed), so the trim snapped the
    # in-point onto a grid the encode never used, and the probe then recomputed the count
    # from the already-snapped seconds: ceil on the wrong grid, floor on the right one.
    # MEASURED on a 29.97 source declared 29: true range 200..259 delivered as 200..258, last
    # frame lost, frames_trimmed=1 for a range that was already whole. A 23.976 source
    # declared 23: frame 0 was 72, the neighbour's frame, where 73 was right. 4 of 4 cuts
    # wrong at one edge; the control with correct declarations was exact. 62 of 87 real
    # exports on the shared drive carry at least one such file. Nothing between the old
    # position and this one reads a trimmed value or an output name, and the manifest is
    # written after this point on every path, so the move costs nothing but the fix.
    # Outside the `if not args.no_probe` block on purpose: a --no-probe run must still be
    # trimmed and named — on whatever rate it has.
    # Named now, while the list is final — so --manifest-only and the sheet can show the
    # filenames without a single frame being encoded.
    # BEFORE the names and the manifest: both are built from the ranges this may change.
    # ⚠️ ALWAYS, NOT A CHOICE. This was a tick nobody could evaluate: "whole frames only"
    # asks the editor to reason about sub-frame source positions in order to decide whether
    # they want a frame of the neighbouring shot at the head. Nobody wants that, so the
    # tick had exactly one correct setting and shipping the other one was a trap. It is now
    # the behaviour. --whole-frames is still ACCEPTED and ignored, because an installed
    # panel older than this release still sends it and argparse would refuse the run.
    # In render mode a timeline range is already frame-aligned, so this finds nothing to do.
    if not getattr(args, "render_dir", None):
        n_trim = trim_to_whole_frames(tl.cuts, tl.warnings)
        if n_trim:
            print(f"\n  pulled {n_trim} cut(s) in to whole source frames "
                  f"({sum(c.frames_trimmed for c in tl.cuts)} frame(s) dropped in total)")
    # ⚠️ A CUT PULLED BACK TO THE END OF ITS MEDIA IS ANNOUNCED, not quietly shortened. It is
    # a frame or two and it is not the editor's doing — Premiere counts a file's length in
    # whole frames and can count one more than the file holds — but a delivered clip that is
    # shorter than its timeline slot has to be traceable to a sentence somebody read.
    _hang = [c for c in tl.cuts if getattr(c, "overhang_trimmed", False)]
    if _hang:
        _names = sorted({c.clip_name or Path(c.source_path).name for c in _hang})
        tl.warnings.append(
            f"{len(_hang)} clip(s) reach the last frame of their media and were pulled back "
            f"to it — Premiere counts the file as longer than it is, so these are up to "
            f"{OVERHANG_TRIM_FRAMES} frame(s) shorter than their timeline slot: "
            + ", ".join(_names[:4]) + (", …" if len(_names) > 4 else ""))

    assign_output_names(tl.cuts, args.container, tl.sequence_fps, cut_from_of(args),
                        int(getattr(args, "index_pad_to", 0) or 0))

    # ⚠️ A RENDER THAT IS NOT THE LENGTH OF ITS CUT IS NOT THAT CUT'S FRAMES.
    #
    # The encode pins -frames:v to the cut's own length with no seek, so ffmpeg keeps the
    # FIRST N frames of the render. That is right when a too-long render overshot at the
    # tail and wrong at every single frame when it overshot at the head. Measured across 12
    # real exports: 1 render-mode clip in 140, delivered `status ok`, `frame_exact true`,
    # notes empty, holding timeline 972..1049 under a label reading 973..1050.
    #
    # resolve_render_overshoot reads the pixels and says which end it was, or says it cannot
    # tell — and run_cut refuses the ones it cannot tell. Nothing is guessed here.
    #
    # ⚠️ NOT INSIDE `if not args.no_probe`, WHICH IS WHERE THIS FIRST LANDED. attach_renders
    # measures the RENDERS, not the sources, so none of this depends on the source probe —
    # and under --no-probe the whole pass simply did not run. It is also before the
    # manifest-only return, so a panel SCAN reports the disagreement rather than only an
    # export discovering it. The one thing that must stay after this point is nothing: it is
    # the last statement in main() that changes a cut.
    if getattr(args, "render_dir", None):
        resolve_render_overshoot(tl.cuts, Path(args.render_dir),
                                 getattr(args, "timeline_ranges", None))
    # ⚠️ A GUESSED COUNT IS EXCLUDED HERE TOO, NOT JUST FROM THE REPAIR. The first pass at
    # this put `not render_frames_derived` in resolve_render_overshoot's filter and nowhere
    # else, which stopped the false REFUSALS and left everything downstream still treating
    # the guess as a measurement: the clip lost frame_exact, picked up a "render +1 frame(s)
    # vs the timeline" note, and was named in "check these in Premiere before delivering" —
    # about a folder in which every render was exact. Worse, one guessed row clears
    # settings.frame_exact for the WHOLE run, and tests/verify.py then refuses to grade the
    # export and prints "This export was RESAMPLED to None fps", on a run with no --fps at
    # all. Found by review. A guess is reported as a guess, below, and decides nothing.
    _shifted = [c for c in tl.cuts
                if c.render_path and c.render_frames and c.duration_frames
                and not c.render_frames_derived
                and c.render_frames != c.duration_frames]
    _guessed = [c for c in tl.cuts
                if c.render_path and c.render_frames and c.duration_frames
                and c.render_frames_derived
                and c.render_frames != c.duration_frames]
    for c in _shifted:
        # The pixels are the timeline's, but the FILE is not the length the timeline says,
        # and until the surplus frame is PLACED this cut cannot claim to be frame exact.
        # ⚠️ BOTH RESOLVED OUTCOMES ARE EXACT, not just the head one. A head overshoot is
        # exact once the surplus frame is dropped in the encode; a TAIL overshoot is exact
        # already — keeping the first N frames was the right thing to do all along, and the
        # only new fact is that it has now been checked against the next render rather than
        # assumed. A first draft marked the tail case not-exact and then warned that it
        # might be shifted, which is the engine reporting doubt about something it had just
        # verified. Only "unclear" and the short renders keep the flag off.
        # ⚠️ AND ONLY FOR A CLIP THAT WILL ACTUALLY SHIP. A refused cut writes no file, so
        # calling it "not frame exact" is a claim about pixels that do not exist — and it
        # drags settings.frame_exact down with it, which is the flag verify.py reads to
        # decide whether the export can be graded at all. The useful meaning of the run-level
        # flag is "every file that WAS delivered holds exactly the frames the timeline used",
        # and a refusal does not contradict that; the refusal itself is the report. Both
        # resolved outcomes are exact — a head overshoot once the surplus frame is dropped,
        # a tail overshoot already — so what is left is the disagreements that ship
        # unresolved.
        if (c.render_overshoot not in ("head", "tail")
                and abs(c.render_frames - c.duration_frames) <= RENDER_FRAME_SLACK
                and c.render_overshoot != "unclear"):
            c.frame_exact = False
    # ⚠️ THREE OUTCOMES, THREE SENTENCES, because the first draft gave all of them one and
    # it was wrong for two. It said "check these in Premiere before delivering" about every
    # render inside RENDER_FRAME_SLACK — including the SHORT ones, which was measured to be
    # false: a 59-frame render into a 60-frame slot produces no file at all, so the warning
    # named a clip that did not exist and asked him to inspect it. A clip that ships, a clip
    # that is refused, and a clip that was repaired are three different pieces of news.
    _fixed = [c for c in _shifted if c.render_overshoot == "head"]
    _checked = [c for c in _shifted if c.render_overshoot == "tail"]
    # ⚠️ SHORT RENDERS ARE THEIR OWN CASE, and lumping them in with the refusals was wrong
    # twice over. run_cut refuses an "unclear" render deterministically; it does NOT refuse a
    # short one — under a downward --fps the resampler maps the surviving frames onto every
    # output slot and the clip is delivered, correct, status ok (documented policy, measured
    # 6 Sep). So the sentence "these clips are REFUSED, re-render these ranges" was being
    # said about clips the same run then wrote to disk. Found by review, and it is the third
    # time today one warning has been made to speak for outcomes that differ.
    _stuck = [c for c in _shifted if c.render_overshoot == "unclear"]
    _short = [c for c in _shifted
              if c not in _stuck and c.render_frames < c.duration_frames
              and abs(c.render_frames - c.duration_frames) <= RENDER_FRAME_SLACK]
    _ship = [c for c in _shifted
             if c not in _fixed and c not in _checked and c not in _stuck
             and c not in _short
             and abs(c.render_frames - c.duration_frames) <= RENDER_FRAME_SLACK]

    def _named(rows):
        return (", ".join(f"{c.clip_name} [{render_name(c)}] "
                          f"({c.render_frames - c.duration_frames:+d}f)"
                          for c in rows[:6])
                + (", …" if len(rows) > 6 else ""))

    if _fixed:
        tl.warnings.append(
            f"{len(_fixed)} render(s) came back a frame long at the HEAD — the surplus "
            f"frame is the previous clip's last one, measured against that render, and it "
            f"is dropped so these cuts still start where the timeline says: "
            + _named(_fixed))
    if _checked:
        # Advisory on purpose: nothing is wrong with these clips and nothing was done to
        # them. It is said at all because a render that is not its cut's length is worth
        # knowing about even when it turns out to be harmless — the alternative is silence
        # that looks identical to the case nobody checked.
        tl.warnings.append(
            f"{len(_checked)} render(s) came back a frame long at the TAIL — the surplus "
            f"frame is the next clip's first one, measured against that render, and it "
            f"falls outside the cut anyway, so these clips are correct as delivered: "
            + _named(_checked))
    if _stuck:
        tl.warnings.append(
            f"{len(_stuck)} render(s) are not the length of the cut they belong to and "
            f"cannot be repaired from the picture — these clips are REFUSED rather than "
            f"delivered possibly a frame out of step. Re-render these ranges in Premiere: "
            + _named(_stuck))
    if _short:
        # Deliberately does not predict the outcome, because main() cannot know it: whether
        # the missing frames can be made up depends on the --fps arithmetic that run_cut has
        # not done yet. Both possibilities are stated, and both are true.
        tl.warnings.append(
            f"{len(_short)} render(s) are SHORTER than the cut they belong to. Where the "
            f"missing frames cannot be made up the clip fails with the render named; "
            f"otherwise it is delivered at the right length. Re-render these ranges in "
            f"Premiere to be sure: " + _named(_short))
    # ⚠️ AND THE WORST ONES WERE THE ONLY ONES WITH NOTHING SAID ABOUT THEM. Every bucket
    # above is gated on the disagreement being inside RENDER_FRAME_SLACK, so a render off by
    # hundreds of frames — the whole-timeline export that started all of this — produced no
    # sentence at all, while a +1 tail overshoot that needed no action produced a paragraph.
    # run_cut does refuse them individually, by name, with both numbers; this is the line
    # that says how many, in the same place as the others.
    _gross = [c for c in _shifted
              if abs(c.render_frames - c.duration_frames) > RENDER_FRAME_SLACK]
    if _gross:
        tl.warnings.append(
            f"{len(_gross)} render(s) are nowhere near the length of the cut they belong "
            f"to — not the range they should be, so nothing is encoded from them. "
            f"Re-render these ranges in Premiere: " + _named(_gross))
    if _guessed:
        # Advisory: nothing is known to be wrong, and the number that looked wrong is one
        # the engine computed rather than read. Said anyway, because silence here would be
        # indistinguishable from a folder nobody checked.
        tl.warnings.append(
            f"{len(_guessed)} render(s) do not report their own length, so the engine had "
            f"to estimate it from the file's duration and the estimate disagrees with the "
            f"cut by a frame. Nothing is decided on an estimate, and these clips are cut "
            f"normally: " + _named(_guessed))
    if _ship:
        tl.warnings.append(
            f"{len(_ship)} render(s) are not the length of their cut, so their frames may "
            f"be shifted against the timeline — check these in Premiere before delivering: "
            + _named(_ship))

    # Only a panel dump carries Premiere's interpreted rate, and only after probing can
    # it be compared with the file's own. A disagreement means the edit was built on a
    # different rate to the one ffmpeg will read, so those clips are named rather than
    # quietly cut — see Cut.interpreted_fps for why this is a warning, not a fix.
    reinterpreted = [c for c in tl.cuts
                     if c.interpreted_fps > 0 and c.source_fps > 0
                     and abs(c.interpreted_fps - c.source_fps) / c.interpreted_fps > 0.002]
    if reinterpreted:
        print(f"\n  !! {len(reinterpreted)} cut(s) use footage Premiere has "
              f"REINTERPRETED — the edit's rate is not the file's:")
        for c in reinterpreted[:8]:
            print(f"     {c.clip_name}: Premiere {c.interpreted_fps:g} fps, "
                  f"file {c.source_fps:g} fps")
        print("     Ranges are right; lengths are unverified.")

    # ⚠️ VARIABLE-RATE MEDIA, NAMED RATHER THAN CUT IN SILENCE. Every length this tool
    # promises rests on frames being evenly spaced: -frames:v pins a COUNT, and the count is
    # turned back into a duration at one rate. On a source whose frames are not evenly
    # spaced that sum is wrong at both ends. MEASURED on a 30 fps file with one frame
    # removed (r 30/1, avg 9000/301): a 30-frame cut across the gap delivered its 30 frames
    # — so the pin was satisfied and the count check passed — but the gap survived into the
    # output timestamps, the file spans 1.033008 s of a 1.000 s timeline slot, and its last
    # picture is the frame AFTER the out-point. The control cut, clear of the gap, was
    # 1.000000. Nothing said so: status ok, frame_exact true, notes empty, warnings [].
    #
    # A WARNING, NOT A REFUSAL, and deliberately: refusing would stop cutting a whole class
    # of real footage (screen captures, phone video) on a threshold nobody here has measured
    # against a real client's rushes, and the delivery today is a third of a frame out, not
    # unusable. 0.2% is the same gap the REINTERPRETED check above treats as a real
    # disagreement rather than float noise.
    vfr = [c for c in tl.cuts
           if not c.render_path and c.media_kind == "video" and variable_rate_source(c)]
    if vfr:
        _vfr_names = sorted({c.clip_name or Path(c.source_path).name for c in vfr})
        # ⚠️ SAY WHAT WAS MEASURED, WHICH IS THE CONTAINER'S OWN TWO NUMBERS DISAGREEING —
        # not "the frames are not evenly spaced", which this check never looked at and which
        # was false on the file that produced the report. Measured on that phone clip: 1,906
        # of its 1,911 frame gaps are identical and the largest is 0.0183 s, so its frames
        # ARE evenly spaced; what differs is the header, which declares a nominal rate and an
        # average that cannot both be true of 1,912 frames. Asserting unevenness sent the
        # reporting editor to inspect footage that was fine, while the real cause — a clip
        # reaching past the end of its media — went unnamed for an evening.
        print(f"\n  !! {len(vfr)} cut(s) come from media whose own header disagrees about "
              f"its frame rate:")
        for c in vfr[:8]:
            print(f"     {c.clip_name}: {c.source_fps:g} fps declared, "
                  f"{c.source_avg_fps:g} average over the file")
        print("     Ranges are right; the delivered length may not fill the timeline slot.")
        tl.warnings.append(
            f"{len(vfr)} cut(s) come from media whose header disagrees with itself about "
            f"the frame rate, so the delivered length may not match the timeline slot: "
            + ", ".join(_vfr_names[:4])
            + (", …" if len(_vfr_names) > 4 else ""))

    # An .aep isn't "missing" — it's a Dynamic Link comp that was never a file ffmpeg
    # could read, and the fix is to render it, not to remap a path. Keep them apart.
    # Everything is encoded 8-bit 4:2:0 so the files play on a Mac. When a source carries
    # more than that — 10-bit, 4:2:2, 4:4:4 — real fidelity is being dropped, and that
    # should be said out loud rather than discovered later in the manifest.
    RICHER = {"yuv422p", "yuv444p", "yuv420p10le", "yuv422p10le", "yuv444p10le",
              "yuv420p12le", "yuv422p12le", "yuv444p12le", "gbrp", "gbrp10le"}
    downgraded = sorted({c.pix_fmt for c in tl.cuts
                         if c.media_kind == "video" and c.pix_fmt in RICHER})
    for fmt in downgraded:
        print(f"  !! source is {fmt}; output is 8-bit yuv420p — chroma and/or bit depth "
              f"are reduced (needed for playback).")

    # ⚠️ NOT ASKED OF A CUT WHOSE PIXELS COME FROM A RENDER. attach_renders has already run
    # by here, so `render_path` is the fact rather than a prediction: that cut is read out
    # of Premiere's file and its source path is not opened by anything. MEASURED on the
    # repo fixture under --render-dir with 18 of 19 renders present: the run told the reader
    # to --remap a path and to render two comps that Premiere had ALREADY rendered — all
    # three rows carried a render_path and were listed as "ready — from render" in the same
    # manifest. Gated on the render, not on render mode: audio is cut from its source in
    # every mode, so a missing .wav still has to be said out loud on a render-mode export.
    _no_render = [c for c in tl.cuts if not c.render_path]
    missing = [c for c in _no_render
               if not c.source_exists and c.media_kind != "unsupported"]
    if missing:
        print(f"\n  !! {len(missing)} cut(s) reference media that isn't at the recorded path:")
        for p in sorted({c.source_path for c in missing})[:8]:
            print(f"     {p}")
        print("     Fix with --remap OLD=NEW.")
    # ⚠️ TWO DIFFERENT THINGS UNDER ONE media_kind. A clipitem with no <pathurl> — an
    # adjustment layer, an Essential Graphics title, a synthetic — is "unsupported" for the
    # same reason an .aep is (nothing ffmpeg can open) but it is not a Dynamic Link comp,
    # and it has no path to print: the list used to show a blank indented line for it,
    # under a sentence that named it a project file. The parser already reports these
    # by NAME further up; here they get the count and the honest description.
    unsupported = [c for c in _no_render if c.media_kind == "unsupported"]
    _comps = [c for c in unsupported if c.source_path]
    _pathless = [c for c in unsupported if not c.source_path]
    if _comps:
        print(f"\n  !! {len(_comps)} cut(s) are project/comp files (Dynamic Link), "
              f"not decodable media — render them first:")
        for p in sorted({c.source_path for c in _comps})[:8]:
            print(f"     {p}")
    if _pathless:
        _names = sorted({c.clip_name or "(unnamed)" for c in _pathless})
        # ⚠️ NOT `!!`, AND NOT "not cut". This is the one advisory in the summary that is
        # normal rather than wrong: every timeline with a title on it produces it. Under the
        # alarm prefix, a source-mode export of a real timeline carrying 31 graphics read as
        # 31 things having gone wrong — the reporting editor asked why 31 files "failed"
        # when nothing had. It says what these clips ARE and which mode does produce them.
        # The warnings list above already carries this sentence, and the console prints it
        # from there. This block adds only the NAMES, which the one-line warning truncates.
        # Only when the one-line warning had to truncate: it lists four names, and a
        # timeline with five titles does not need the same four printed twice.
        if len(_names) > 4:
            print(f"\n  ++ all {len(_pathless)} of them:")
            for n in _names[:8]:
                print(f"     {n}")
    if missing or unsupported:
        print()

    # Made and PROVEN WRITABLE before a single ffmpeg starts. A destination that exists but
    # refuses writes used to be found out one clip at a time: measured on a `chmod 555`
    # folder, every cut failed with ffmpeg's own "Permission denied" and the run then ended
    # in a `PermissionError` traceback out of the manifest write. One probe file answers
    # the same question in a millisecond, and says it in a sentence.
    try:
        args.out.mkdir(parents=True, exist_ok=True)
        _probe = args.out / ".xmlcut-write-test"
        try:
            _probe.write_bytes(b"")
        finally:
            try:
                _probe.unlink()
            except OSError:
                pass
    except OSError as _e:
        sys.exit(f"error: cannot write to --out {args.out} ({_e}). Pick a folder you can "
                 f"write to, or fix its permissions.")

    # ⚠️ 3.93 AUDIT · THE LOCK, THE LEDGER AND --resume's PLAN LIVE IN open_export_folder(),
    # WHICH THE BROWSER GUI CALLS TOO. They were written inline here, so xmlcut_gui.py — which
    # runs its own pool — took none of them: no lock, no ledger, a Resume that kept nothing.
    # Registered before the lock is taken so a run that dies between the two still lets go.
    atexit.register(release_run_locks)
    _busy = open_export_folder(tl, args)
    if _busy:
        sys.exit(f"error: {_busy}.")

    # The tail of tl.warnings: everything the probe and resume passes found after the
    # header was printed. Same markers, same list — this is a second flush, not a second
    # class of warning. See _warned_upto above.
    for w in tl.warnings[_warned_upto:]:
        print(f"  {'++' if is_advisory_warning(w) else '!!'} {w}")

    if args.manifest_only:
        # The walk-through scans into the folder it is about to cut into. When that folder
        # already holds an export, its manifest is the record --resume reads (see the
        # refusal near the top of main()), so the scan's list is shown and NOT written: a
        # "no" at the prompt below then leaves the folder exactly as it was, and a "yes"
        # writes the real manifest at the end of the cut.
        if getattr(args, "interactive", False) and export_held_in(args.out):
            print(f"\nCut list not written: {args.out} already holds an export, and its "
                  f"manifest stays until this run replaces it.")
        else:
            csv_p, json_p, sheet_p = write_manifest_or_exit(tl, args.out, args)
            print(f"\nCut list written:\n  {csv_p}\n  {json_p}\n  {sheet_p}")
        if not getattr(args, "interactive", False):
            return
        extractable = sum(1 for c in tl.cuts
                          if c.source_exists and c.media_kind != "unsupported")
        print(f"\n{extractable} of {len(tl.cuts)} clips can be extracted.")
        if extractable == 0:
            print("Nothing to cut — fix the missing media first.")
            return
        if input("\nCut them now? [Y/n]: ").strip().lower().startswith("n"):
            print("Stopped. The cut list above still stands.")
            return
        args.manifest_only = False
        print()

    if args.save_preset:
        # The export is the job here: a presets file that cannot be read costs the SAVE,
        # said on a `!!` line, and never the export — nor the presets in that file.
        try:
            save_preset(args.save_preset, preset_from_args(args))
            print(f"  saved export preset {args.save_preset!r} to {presets_path()}")
        except PresetsUnreadable as e:
            print(f"  !! export preset {args.save_preset!r} NOT saved: {e}")

    # A Cancel stops the encodes and takes their partials with it; see _stop_on_signal.
    install_stop_handler()
    ready_folder_for_encode(tl, args)

    print(f"\nCutting with {JOBS} parallel job(s) ...")
    done = 0
    # Reason text -> how many clips gave it. See the print inside the loop.
    _said_errors: dict[str, int] = {}
    # ⚠️ CTRL-C HAS TO STOP THE QUEUE, AND `with ThreadPoolExecutor` DOES NOT. The
    # KeyboardInterrupt surfaces here, in as_completed, and the executor's __exit__ is
    # shutdown(wait=True) with nothing cancelled — so every clip not yet started was started
    # anyway, one worker at a time, before the interrupt was allowed to finish. MEASURED on
    # the fixture at --x264-preset veryslow, SIGINT to the process group 1.5 s in: the
    # in-flight encodes died with it, then 11 more delivery-named clips were written over
    # the next 4 s with no progress line for any of them, and the run ended in a
    # KeyboardInterrupt traceback, exit -2, and NO manifest. (The panel's Cancel is
    # SIGTERM/SIGKILL on the group and never came through here; this is a terminal run.)
    #
    # So the interrupt cancels what has not started, waits for what has — in a terminal
    # those ffmpegs took the same signal and are already stopping — and the run then says
    # what it did and writes a manifest that describes it, below.
    _interrupted = False
    ex = ThreadPoolExecutor(max_workers=JOBS)
    futures: dict = {}
    try:
        _NESTED_SIGNALS.clear()
        _SIGINT_TO_MAIN[0] = True        # see _SIGINT_TO_MAIN: Ctrl-C comes back here
        futures = {ex.submit(run_cut, c, args.out, args, tl.sequence_fps): c
                   for c in tl.cuts}
        # Where the stop handler can cancel what has not started yet.
        with _INFLIGHT_LOCK:
            _INFLIGHT_FUTURES[:] = list(futures)
        for c in settled_results(futures, args):
            done += 1
            # ⚠️ no_render AND render_mismatch WERE IN NO MAP AND NO TOTAL. run_cut refuses
            # a cut with "no_render" (Premiere never produced the range) or
            # "render_mismatch" (the render is not the range it claims); neither had an entry
            # here, so those lines printed a bare `?`, and neither was a term in the Done
            # line below. MEASURED on 19 planned ranges with three omitted and one built at
            # the wrong length: `Done: 15 written, 0 failed, 0 missing source, 0 unsupported`,
            # exit 0, 15 files on disk, completeness "all 19 cuts on the timeline". This
            # project has shipped that failure twice.
            #
            # The panel needs no change for these: main.js parses the flag with
            # /\[(\d+)\/(\d+)\]\s+(\S+)\s*(.*)$/ and treats anything that is not OK or
            # HAVE as bad, so NORE and "BAD " both slot in.
            flag = {"ok": "OK ", "dry_run": "DRY", "missing_source": "MISS",
                    "skipped_existing": "HAVE", "no_audio": "SLNT",
                    "no_render": "NORE", "render_mismatch": "BAD ",
                    "failed": "FAIL", "unsupported": "SKIP"}.get(c.status, "?")
            print(f"  [{done}/{len(tl.cuts)}] {flag} {c.output_file}")
            # ⚠️ THE SAME REASON, ONCE. Measured on a real 87-cut timeline: nineteen clips
            # were skipped for the identical reason and the run printed that one sentence
            # nineteen times, ~95 characters each. The clip is already named on the line
            # above and the manifest carries every error in full, so the repeat bought
            # nothing and buried the lines that differ.
            if c.error:
                # ⚠️ WRAPPED, NOT CUT OFF. This truncated at 160 characters, which was fine
                # while every reason was one short clause and silently useless the moment one
                # was not: the overhang message added on 8 Sep runs to 244 characters and the
                # console printed it up to "…Premiere believes the file", dropping the half
                # that says what to do — "is longer than it is; trim the clip to the end of
                # the footage, or replace the media". The whole point of that sentence is the
                # instruction, and only the manifest ever carried it. De-duplication still
                # keys on the first 160 characters, which is what made repeats collapse.
                _line = c.error.splitlines()[0]
                _key = _line[:160]
                if _key in _said_errors:
                    _said_errors[_key] += 1
                else:
                    _said_errors[_key] = 1
                    # ⚠️ NEITHER HYPHENS NOR LONG WORDS ARE BREAK POINTS. textwrap's
                    # defaults split on both, and every one of these reasons carries a
                    # file path. A scratch path with hyphens in its folder names came out
                    # broken across three lines at those hyphens: a path nobody can copy
                    # and a string nothing can match. A path longer than the width now
                    # overflows its line intact, which is the right trade.
                    _parts = textwrap.wrap(_line, 96, break_on_hyphens=False,
                                           break_long_words=False) or [_line]
                    for _i, _part in enumerate(_parts):
                        print(f"        {_part}" if _i == 0 else f"          {_part}")
    except KeyboardInterrupt:
        _interrupted = True
        _unstarted = sum(1 for f in futures if f.cancel())
        print(f"\n  !! interrupted — {_unstarted} clip(s) not started and will not be; "
              f"waiting for the ones already encoding to stop …", flush=True)
        try:
            if signal.SIGINT in _NESTED_SIGNALS:
                raise KeyboardInterrupt       # pressed twice before the first was handled
            ex.shutdown(wait=True)
        except KeyboardInterrupt:
            # A second Ctrl-C means "stop waiting". os._exit, not sys.exit: the executor's
            # own exit hook joins its workers, which is the wait being refused. A clip cut
            # short here is left under its hidden .part name (see partial_name), never
            # under a delivery name, and no manifest claims it.
            #
            # ⚠️ BUT NOT IN THE MIDDLE OF A WORKER'S FOLDER STEP (see _COMMIT_LOCK): taking
            # the lock first means os._exit lands between steps, like the stop handler's own
            # death. Bounded, for the same reason the handler's is.
            _COMMIT_LOCK.acquire(timeout=1.0)
            print("  !! stopped without waiting. No manifest was written; run the same "
                  "command again with --resume to finish.", flush=True)
            release_run_locks()
            os._exit(130)
    finally:
        ex.shutdown(wait=True)
        _SIGINT_TO_MAIN[0] = False

    # Said once each above; here is what that spared, so a collapsed count is never a
    # silent one. The manifest holds every clip's error in full either way.
    _repeats = sum(n - 1 for n in _said_errors.values() if n > 1)
    if _repeats:
        print(f"  ({_repeats} repeat(s) of a reason already given above — see the manifest "
              f"for every clip's own line)")

    if _interrupted:
        # ⚠️ RECORDED AS `failed`, NOT LEFT `pending`, AND THE DIFFERENCE IS --resume. The
        # next resume trusts only ok/skipped_existing rows and treats a failed one as
        # wreckage to re-cut. A clip that was never reached may still have a file from an
        # EARLIER run under its name — possibly at other settings, which this run's manifest
        # would no longer record — and adopting that by filename is the silent-bad-data
        # direction. Re-encoding it costs seconds.
        _uncut = mark_unstarted_after_stop(tl, args)
        # No whole-timeline audio: that is another ffmpeg run the interrupt asked not to
        # have. The manifest is still written, because it is what lets --resume keep the
        # clips that did finish by id rather than by filename.
        csv_p, json_p, sheet_p = write_manifest_or_exit(tl, args.out, args)
        _t = collections.Counter(c.status for c in tl.cuts)
        print(f"\nInterrupted: {_t['ok']} written, {len(_uncut)} never started, "
              f"{_t['failed'] - len(_uncut)} stopped mid-encode or failed. Run the same "
              f"command again with --resume to finish.")
        print(f"Manifest: {csv_p}\nSheet   : {sheet_p}")
        # 128 + SIGINT, what a shell reports for a job stopped by Ctrl-C, so a script
        # chaining off `&&` does not take a third of a folder as a delivery.
        return 130

    # ⚠️ A CLIP THIS RUN DID NOT PRODUCE KEEPS NOTHING OF AN EARLIER RUN UNDER ITS NAME.
    # See set_aside_leftovers. Said by name, and on screen as well as in the manifest,
    # because the editor's next move depends on it: those files are no longer where the
    # delivery is, and the ones worth keeping have to be put back by hand.
    settle_folder_after_encode(tl, args)

    # The single whole-timeline mp3, after the cuts and before the manifest that records it.
    if getattr(args, "audio_per_track", False):
        # ⚠️ ONE FILE PER TRACK, and it is a different answer from both of its neighbours.
        # The per-cut files pair with the clips; the single mixed mp3 sums every chosen
        # track into one. Neither is "A2, whole" — which is what a voice-over actually is,
        # and what was asked for on 8 Sep: "ngta chỉ cần file VO từ đầu tới cuối thôi".
        args.track_audio = write_track_audio(tl, args)
        for _ta in args.track_audio:
            if _ta.get("file"):
                print(f"\n  A{_ta['track']} as one file: {_ta['file']} "
                      f"({_ta['seconds']:.2f}s, {_ta['parts']} item(s))")
                # ⚠️ THE NOTE TOO, when there is a file. It used to print only when nothing
                # was written, so a track file with a retimed SFX left out of it — a silent
                # gap where the zip should be — said nothing anywhere a person looks.
                if _ta.get("note"):
                    print(f"      {_ta['note']}")
            elif _ta.get("note"):
                print(f"\n  A{_ta.get('track')}: {_ta['note']}")
        if not args.track_audio:
            print("\n  no per-track audio: this timeline has no audio items")
    if getattr(args, "audio", False):
        args.timeline_audio = write_timeline_audio(tl, args)
        if args.timeline_audio.get("file"):
            print(f"\n  whole-timeline audio: {args.timeline_audio['file']} "
                  f"({args.timeline_audio['seconds']:.2f}s, "
                  f"{args.timeline_audio['parts']} item(s))")
            if args.timeline_audio.get("note"):
                print(f"      {args.timeline_audio['note']}")
        elif args.timeline_audio.get("note"):
            print(f"\n  no whole-timeline audio: {args.timeline_audio['note']}")
    # ⚠️ AND A MIX THIS RUN WAS ASKED FOR AND DID NOT WRITE leaves no earlier one under its
    # name. MEASURED on 3.88: a folder holding a good 864044-byte mix, re-exported with the
    # mix failing, kept the old file under `_timeline_audio.mp3` while the manifest said no
    # mix was made. Only the names THIS run was asked for: a track nobody ticked this time
    # is not this run's to move.
    if not args.dry_run:
        _asked = []
        if getattr(args, "audio", False):
            _asked.append(("_timeline_audio.mp3", args.timeline_audio or {}))
        for _ta in (getattr(args, "track_audio", None) or []):
            if _ta.get("track") is not None:
                _asked.append((f"_track_A{_ta['track']}.mp3", _ta))
        _mixes, _stuck = [], []
        # One step with its `!!` line and the ledger's note, like every other move.
        with uninterrupted():
            for _nm, _res in _asked:
                if _res.get("file") or not (args.out / _nm).is_file():
                    continue
                _where = move_aside(args.out, _nm)
                if _where and args.ledger is not None:
                    args.ledger.note_aside(_nm, _where, "its mix failed this run")
                (_mixes if _where else _stuck).append(f"{_nm} -> {_where}" if _where else _nm)
            # ⚠️ ONLY WHAT MOVED IS CALLED MOVED. This said "moved aside, not deleted" of files
            # that could not be moved (an unwritable folder, measured), and the very next `!!`
            # line — report_audio_deliveries — rightly called them still in place. Those are
            # left to that line.
            if _mixes:
                _warn_now(tl.warnings,
                          f"{len(_mixes)} audio file(s) from an EARLIER run were under the name "
                          f"of a mix this run did not produce — moved aside, not deleted: "
                          + ", ".join(_mixes))
    report_audio_deliveries(tl, args)

    csv_p, json_p, sheet_p = write_manifest_or_exit(tl, args.out, args)
    tally = collections.Counter(c.status for c in tl.cuts)
    extra = "".join(
        f", {tally[k]} {label}" for k, label in
        (("skipped_existing", "already there"), ("no_audio", "silent source"),
         # Both of these are a clip that was PROMISED and did not arrive. They ride on the
         # same `extra` mechanism rather than being folded into `failed`, because the two
         # causes want different actions: re-render the range, or re-render it at the right
         # length. What they may not do is go unmentioned.
         ("no_render", "no render"), ("render_mismatch", "render not the range"))
        if tally[k])
    print(f"\nDone: {tally['ok']} written, {tally['failed']} failed, "
          f"{tally['missing_source']} missing source, "
          f"{tally['unsupported']} unsupported{extra}.")

    # ⚠️ WHAT ELSE IS IN THE FOLDER, because "export again" does NOT refresh it.
    #
    # Overwrite is automatic, but it only replaces an EXACT filename match — and the
    # filename carries the source range, so a fix that moves a range by a hundredth of a
    # second gives the same cut a NEW name and leaves the old file sitting beside it.
    # Measured across two real releases on one real timeline: 18 files written, then 16
    # written by the next version, of which 14 of the originals are never written again.
    # A folder nobody clears therefore ends up holding two runs at once, and the numbers a
    # human counts by ("file 9") no longer mean what the manifest means. The reviewer hit
    # exactly this: he re-exported without clearing, then reported head-frame faults that
    # could not be reproduced from the same XML — they were files an older build had left.
    #
    # This does not delete anything. Deciding what to keep is the editor's call; being told
    # is not.
    # ⚠️ CATCHES Exception, NOT OSError, AND THAT BREADTH IS DELIBERATE. This runs after
    # every clip is on disk, so anything it raises destroys a COMPLETED export's exit code
    # and prints a traceback over a run that actually succeeded. The first draft of this
    # block referred to a name that does not exist in this scope and did exactly that —
    # 19 files written, then `NameError` and a non-zero exit. An advisory may not be able
    # to fail the thing it is advising about.
    try:
        _mine = {c.output_file for c in tl.cuts if getattr(c, "output_file", "")}
        _mine.add(Path(csv_p).name)
        _mine.add(Path(sheet_p).name)
        # A renumbered clip's old file kept because its re-encode did not land was already
        # named, with the reason, on its own `!!` line above; "probably an earlier export"
        # a second time about the same file only muddies which warning to act on.
        if getattr(args, "tidy", None) is not None:
            _mine.update(n for n, _ in args.tidy.not_redone)
        _strays = sorted(
            f.name for f in args.out.iterdir()
            if f.is_file() and CUT_FILE_RE.match(f.name) and f.name not in _mine)
    except Exception as _e:                                    # noqa: BLE001
        _strays = []
        print(f"  (could not check the folder for earlier files: {_e})")
    if _strays:
        _shown = ", ".join(_strays[:4]) + (", …" if len(_strays) > 4 else "")
        _msg = (f"{len(_strays)} file(s) in this folder were NOT written by this run and "
                f"are not named by this manifest — probably an earlier export. Left "
                f"alone: {_shown}")
        print(f"\n  !! {_msg}")

    print(f"Manifest: {csv_p}\nSheet   : {sheet_p}")

    # ⚠️ A RUN THAT WROTE NOTHING AT ALL USED TO EXIT 0. Measured with `--pick` on two cuts
    # and `--timeout 0`: `Done: 0 written, 2 failed, 0 missing source, 0 unsupported.`,
    # zero mp4 files in the folder, exit code 0 — so a shell script chaining the next step
    # off `&&` ran it over an empty folder, and the panel, which reads the exit code first,
    # had nothing to complain about.
    #
    # Only the total loss returns 1. A PARTIAL failure still exits 0 on purpose: the
    # manifest names every clip and its own reason, the run said so on screen, and turning
    # "19 of 21 written" into a failed process would break every caller that legitimately
    # ships what came back. Missing sources and undecodable media are not counted here
    # either — those are a timeline that points at media this machine cannot see, which is
    # already reported by name and is not the tool failing.
    #
    # ⚠️ "ALREADY THERE" IS DELIVERED TOO. This tested ok alone, so a resumed run whose
    # re-cuts all failed exited 1 over a folder that was mostly delivered — MEASURED on
    # 3.88: `0 written, 4 failed … 15 already there`, exit 1, where the same four failures
    # with the tick off exit 0 — and the panel put up `xmlcut exited with code 1` as though
    # the whole export had died.
    if tally["ok"] == 0 and tally["skipped_existing"] == 0 and tally["failed"] > 0:
        return 1


if __name__ == "__main__":
    # sys.exit(main()), not a bare main(): cli_update() returns 1 when the check failed and
    # that was being thrown away, so `--update` reported success to a caller no matter what
    # happened. None exits 0, which is every other path.
    sys.exit(main())
