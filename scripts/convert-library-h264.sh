#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-time library conversion: HEVC/AC3 -> H.264/AAC so files DIRECT PLAY in a
# browser with no live transcoding.
#
# Why this exists: ~81% of this library is HEVC, which no browser plays
# natively, so every playback spawned an ffmpeg transcode. When the source is
# also on a network mount, that transcode waits on the network and the player
# shows an endless spinner. Converting once removes the transcode from every
# future playback -- and makes the library cheap to serve from hardware with no
# GPU (AWS App Runner/Fargate have no /dev/dri at all).
#
# Uses VAAPI hardware encoding when available (measured ~8.9x realtime at 63%
# CPU here, versus 3.2x at 323% for software x264).
#
# SAFETY: originals are never touched unless --replace is passed, and even then
# only after the new file has been probed and confirmed valid. Interrupted
# conversions leave a .part file that is cleaned up on the next run, never a
# corrupt output in place of a good original.
#
#   scripts/convert-library-h264.sh --dry-run            # show the plan only
#   scripts/convert-library-h264.sh --limit 3            # convert 3, keep originals
#   scripts/convert-library-h264.sh --archive            # convert all, move originals aside
#   scripts/convert-library-h264.sh --replace            # convert all, delete verified originals
#
# NOTE ON DUPLICATES: the library scanner walks every video file and does not
# deduplicate by title, so an original left next to its converted copy shows up
# as a SECOND entry for the same episode. --archive moves originals to
# <root>-originals/ (outside the scanned root) which avoids that while keeping
# them recoverable; --replace deletes them outright. Plain runs keep them in
# place, which is fine for a --limit test but will duplicate the library if used
# for a full run.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="${NEXUS_MEDIA_ROOT:-/home/moh/nexus-media}"
OUT_SUFFIX=".h264.mp4"
VAAPI_DEVICE="${NEXUS_VAAPI_DEVICE:-/dev/dri/renderD128}"
QP="${NEXUS_CONVERT_QP:-23}"          # visually transparent-ish for H.264
DRY_RUN=0; REPLACE=0; ARCHIVE=0; LIMIT=0
ARCHIVE_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --replace) REPLACE=1 ;;
    --archive) ARCHIVE=1 ;;
    --limit)   LIMIT="${2:-0}"; shift ;;
    --root)    ROOT="${2:-$ROOT}"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

c_ok()   { printf '\033[32m  ok\033[0m   %s\n' "$*"; }
c_skip() { printf '\033[90m  skip\033[0m %s\n' "$*"; }
c_bad()  { printf '\033[31m  FAIL\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

[ -d "$ROOT" ] || { c_bad "No such media root: $ROOT"; exit 1; }
command -v ffmpeg  >/dev/null || { c_bad "ffmpeg not installed";  exit 1; }
command -v ffprobe >/dev/null || { c_bad "ffprobe not installed"; exit 1; }

# ── Encoder selection ────────────────────────────────────────────────────────
# A render node that exists but cannot actually encode (permissions, or a
# session ACL that vanished) is worse than no render node: every file would
# fail one at a time. Probe with a real encode once, up front.
HW=0
if [ -e "$VAAPI_DEVICE" ] && ffmpeg -hide_banner -loglevel error \
     -vaapi_device "$VAAPI_DEVICE" -f lavfi -i testsrc=duration=1:size=320x240:rate=25 \
     -vf 'format=nv12,hwupload' -c:v h264_vaapi -f null - >/dev/null 2>&1; then
  HW=1
  c_info "Hardware encoding available (VAAPI @ $VAAPI_DEVICE)"
else
  c_info "No usable VAAPI device -- falling back to software x264 (much slower)"
fi

# ── Work out what actually needs converting ──────────────────────────────────
needs_conversion() {
  local f="$1" v a ach vcodec pixfmt
  v=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of csv=p=0 "$f" 2>/dev/null | head -1)
  a=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$f" 2>/dev/null | head -1)
  ach=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$f" 2>/dev/null | head -1)
  [ -z "$v" ] && return 1   # not a readable video; leave it alone
  vcodec="${v%%,*}"; pixfmt="${v##*,}"
  case "$vcodec" in
    h264|avc1) [[ "$pixfmt" == *10le* || "$pixfmt" == *10be* ]] && return 0 ;;
    *) return 0 ;;
  esac
  # Multichannel audio is fine to keep as long as its layout is DECLARED.
  # Verified in Chrome: a 5.1 HE-AAC MP4 from this library reaches readyState 4
  # and plays. The documented failure (server.ts HLS_ENCODER_VERSION v3) is
  # specifically 6-channel AAC with an UNKNOWN layout, which is what the check
  # below targets -- blanket-downmixing every 5.1 track would throw away
  # surround audio that works.
  local alay
  alay=$(ffprobe -v error -select_streams a:0 -show_entries stream=channel_layout -of csv=p=0 "$f" 2>/dev/null | head -1)
  case "$a" in
    aac|mp3|opus|vorbis)
      if [ "${ach:-0}" -gt 2 ] 2>/dev/null; then
        case "$alay" in ""|unknown|"unknown"*) return 0 ;; esac
      fi
      ;;
    *) return 0 ;;
  esac
  return 1
}

if (( ARCHIVE && REPLACE )); then
  c_bad "--archive and --replace are mutually exclusive: one keeps originals, the other deletes them."
  exit 1
fi
if (( ARCHIVE )); then
  ARCHIVE_DIR="${NEXUS_ARCHIVE_DIR:-${ROOT%/}-originals}"
  case "$ARCHIVE_DIR" in
    "$ROOT"|"$ROOT"/*) c_bad "Archive dir must be OUTSIDE the media root, or originals stay in the library."; exit 1 ;;
  esac
  mkdir -p "$ARCHIVE_DIR" || { c_bad "Cannot create $ARCHIVE_DIR"; exit 1; }
  c_info "Originals will be archived to: $ARCHIVE_DIR"
fi

c_info "Scanning $ROOT"
mapfile -t FILES < <(find "$ROOT" -type f \
  \( -iname '*.mkv' -o -iname '*.mp4' -o -iname '*.avi' -o -iname '*.m4v' -o -iname '*.mov' -o -iname '*.webm' \) \
  ! -name "*$OUT_SUFFIX" 2>/dev/null | sort)

TODO=(); SKIPPED=0
for f in "${FILES[@]}"; do
  out="${f%.*}$OUT_SUFFIX"
  # Resumable: an existing, valid output means this file is already done.
  if [ -f "$out" ] && ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$out" >/dev/null 2>&1; then
    SKIPPED=$((SKIPPED+1)); continue
  fi
  if needs_conversion "$f"; then TODO+=("$f"); else SKIPPED=$((SKIPPED+1)); fi
done

(( LIMIT > 0 )) && TODO=("${TODO[@]:0:$LIMIT}")

echo
c_info "${#TODO[@]} file(s) to convert, $SKIPPED already fine or done"

# Output can be larger than HEVC input, so check there is room before starting.
if (( ${#TODO[@]} > 0 )); then
  need_mb=0
  for f in "${TODO[@]}"; do
    need_mb=$(( need_mb + $(stat -c%s "$f" 2>/dev/null || echo 0) / 1048576 ))
  done
  # 1.6x is a deliberately pessimistic ratio for HEVC -> H.264 at the same
  # resolution; better to refuse up front than to fill the disk mid-run.
  need_mb=$(( need_mb * 16 / 10 ))
  avail_mb=$(df -Pm "$ROOT" | awk 'NR==2 {print $4}')
  c_info "Estimated space needed: ~$(( need_mb / 1024 )) GB; available: $(( avail_mb / 1024 )) GB"
  if (( need_mb > avail_mb )); then
    c_bad "Not enough free space. Free some up, or run with --limit N in batches."
    exit 1
  fi
fi

if (( DRY_RUN )); then
  echo; c_info "DRY RUN -- nothing will be written. Files that would be converted:"
  printf '  %s\n' "${TODO[@]}"
  exit 0
fi
(( ${#TODO[@]} == 0 )) && { c_ok "Nothing to do."; exit 0; }

# ── Convert ──────────────────────────────────────────────────────────────────
converted=0; failed=0; idx=0
for f in "${TODO[@]}"; do
  idx=$((idx+1))
  out="${f%.*}$OUT_SUFFIX"
  part="$out.part"
  lock="$out.lock"

  # Atomic claim, so several instances of this script can run concurrently and
  # split the work without ever encoding the same file twice. The 10-bit path
  # is software-decode bound and only saturates about half this box's threads,
  # so two instances roughly halve the wall time. noclobber makes the create
  # fail rather than truncate if another instance got there first.
  if ! (set -o noclobber; : > "$lock") 2>/dev/null; then
    printf '\n[%d/%d] %s\n      claimed by another instance -- skipping\n' "$idx" "${#TODO[@]}" "$(basename "$f")"
    continue
  fi
  # Release the claim however this iteration ends, including Ctrl-C.
  trap 'rm -f "$lock" "$part"' EXIT INT TERM

  # The TODO list was built before any work started, so with a sibling instance
  # running it can be stale by the time we get here: that instance may have
  # already converted this file and (with --archive) moved the source out from
  # under us. Re-check both facts now that the claim is held.
  if [ ! -f "$f" ]; then
    printf '\n[%d/%d] %s\n      source already handled by another instance -- skipping\n' "$idx" "${#TODO[@]}" "$(basename "$f")"
    SKIPPED=$((SKIPPED+1)); rm -f "$lock"; trap - EXIT INT TERM; continue
  fi
  if [ -f "$out" ] && ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$out" >/dev/null 2>&1; then
    printf '\n[%d/%d] %s\n      already converted -- skipping\n' "$idx" "${#TODO[@]}" "$(basename "$f")"
    SKIPPED=$((SKIPPED+1)); rm -f "$lock"; trap - EXIT INT TERM; continue
  fi

  rm -f "$part"
  printf '\n[%d/%d] %s\n' "$idx" "${#TODO[@]}" "$(basename "$f")"

  # Only re-encode what is actually wrong. A file that is already H.264 but
  # carries EAC3 audio needs an audio pass and nothing else -- re-encoding its
  # video would cost minutes and lose a generation of quality for no gain.
  srcv=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of csv=p=0 "$f" 2>/dev/null | head -1)
  srca=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$f" 2>/dev/null | head -1)
  srcvcodec="${srcv%%,*}"; srcpix="${srcv##*,}"

  video_ok=0
  case "$srcvcodec" in
    h264|avc1) [[ "$srcpix" == *10le* || "$srcpix" == *10be* ]] || video_ok=1 ;;
  esac
  # Keep multichannel audio when its layout is declared (verified playing in
  # Chrome at readyState 4); only downmix when the layout is unknown, which is
  # the case server.ts's HLS_ENCODER_VERSION v3 note was actually about.
  srcach=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$f" 2>/dev/null | head -1)
  srcalay=$(ffprobe -v error -select_streams a:0 -show_entries stream=channel_layout -of csv=p=0 "$f" 2>/dev/null | head -1)
  audio_ok=0
  case "$srca" in
    aac|mp3|opus|vorbis)
      if [ "${srcach:-0}" -le 2 ] 2>/dev/null; then
        audio_ok=1
      else
        case "$srcalay" in ""|unknown|"unknown"*) audio_ok=0 ;; *) audio_ok=1 ;; esac
      fi
      ;;
  esac

  is10bit=0
  [[ "$srcpix" == *10le* || "$srcpix" == *10be* ]] && is10bit=1

  pre=()
  if (( video_ok )); then
    vid=(-c:v copy)
    printf '      video: copy (already H.264)\n'
  elif (( HW && is10bit )); then
    # h264_vaapi has NO 10-bit profile on this hardware ("No usable encoding
    # profile found"), and browsers cannot play 10-bit H.264 anyway. Decoding
    # in software converts to 8-bit nv12 before the frames reach the GPU, which
    # the encoder does accept. Measured ~7.7x realtime versus ~12.7x for the
    # full-hardware 8-bit path -- slower, but it actually completes.
    pre=(-vaapi_device "$VAAPI_DEVICE")
    vid=(-c:v h264_vaapi -qp "$QP" -vf 'format=nv12,hwupload')
    printf '      video: %s 10-bit -> h264 8-bit (sw decode + hw encode)\n' "$srcvcodec"
  elif (( HW )); then
    pre=(-hwaccel vaapi -hwaccel_device "$VAAPI_DEVICE" -hwaccel_output_format vaapi)
    vid=(-c:v h264_vaapi -qp "$QP" -vf 'format=nv12|vaapi,hwupload')
    printf '      video: %s -> h264 (hardware)\n' "$srcvcodec"
  else
    vid=(-c:v libx264 -preset veryfast -crf "$QP")
    printf '      video: %s -> h264 (software)\n' "$srcvcodec"
  fi

  # Stereo AAC rather than passthrough 5.1: 6-channel AAC with an unknown
  # channel layout made Chrome fail decoder init (see the HLS_ENCODER_VERSION
  # note in server.ts), and stereo is what the HLS path already downmixes to.
  if (( audio_ok )); then
    aud=(-c:a copy)
    printf '      audio: copy (already %s)\n' "$srca"
  else
    aud=(-c:a aac -ac 2 -b:a 192k)
    printf '      audio: %s -> aac stereo\n' "$srca"
  fi

  # Text subtitles carry over as mov_text, MP4's only subtitle format. Image
  # subtitles (PGS/VobSub, from Blu-ray rips) have no MP4 representation at
  # all, so mapping them would fail the whole conversion -- they are dropped
  # deliberately and reported, rather than silently taking the file down with
  # them.
  subargs=(); subnote="none"
  textsubs=$(ffprobe -v error -select_streams s -show_entries stream=index,codec_name -of csv=p=0 "$f" 2>/dev/null \
             | grep -cE ',(subrip|ass|ssa|mov_text|webvtt)$' || true)
  allsubs=$(ffprobe -v error -select_streams s -show_entries stream=index -of csv=p=0 "$f" 2>/dev/null | grep -c . || true)
  if [ "${textsubs:-0}" -gt 0 ]; then
    subargs=(-map '0:s?' -c:s mov_text)
    subnote="$textsubs text track(s)"
    [ "${allsubs:-0}" -gt "${textsubs:-0}" ] && subnote="$subnote ($(( allsubs - textsubs )) image track(s) dropped)"
  elif [ "${allsubs:-0}" -gt 0 ]; then
    subnote="$allsubs image track(s) dropped -- no MP4 equivalent"
  fi
  printf '      subs:  %s\n' "$subnote"

  run_ffmpeg() {
    # $1 = "subs" or "nosubs"; remaining args unused. Reads pre/vid/aud from scope.
    local mode="$1"; shift
    local -a smaps=()
    [ "$mode" = "subs" ] && smaps=("${subargs[@]}")
    rm -f "$part"
    ffmpeg -hide_banner -loglevel error -y -nostdin \
      "${pre[@]}" -i "$f" \
      -map 0:v:0 -map 0:a:0? ${smaps[@]+"${smaps[@]}"} \
      "${vid[@]}" "${aud[@]}" \
      -movflags +faststart \
      -f mp4 "$part" 2>/tmp/nexus-convert-err.log
  }

  # Three attempts, each addressing a DIFFERENT cause, because conflating them
  # is how the first run wasted 24 files: a hardware-encoder failure was
  # misreported as a subtitle problem and retried with the same broken encoder.
  #   1. everything
  #   2. drop subtitles      -- malformed timings/encodings are common
  #   3. software encoder    -- any VAAPI limitation this box happens to have
  ok=0
  if run_ffmpeg subs; then ok=1
  else
    errsnip=$(tr '\n' ' ' < /tmp/nexus-convert-err.log)
    if [ ${#subargs[@]} -gt 0 ]; then
      printf '      retry: without subtitles\n'
      run_ffmpeg nosubs && ok=1
    fi
    if (( ! ok )) && [ "${vid[0]:-}" != "-c:v" -o "${vid[1]:-}" != "copy" ]; then
      printf '      retry: software encoder (hardware path failed: %.70s)\n' "$errsnip"
      pre=(); vid=(-c:v libx264 -preset veryfast -crf "$QP")
      run_ffmpeg nosubs && ok=1
    fi
  fi

  if (( ok ))
  then
    # Never trust an exit code alone: confirm the result is a readable H.264
    # stream with a sane duration before it is allowed to replace anything.
    newdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$part" 2>/dev/null | cut -d. -f1)
    olddur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"    2>/dev/null | cut -d. -f1)
    newcodec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$part" 2>/dev/null | head -1)
    if [ "$newcodec" = "h264" ] && [ -n "$newdur" ] && [ "$newdur" -gt 0 ] \
       && [ $(( newdur > olddur ? newdur - olddur : olddur - newdur )) -le 5 ]; then
      mv -f "$part" "$out"
      converted=$((converted+1))
      c_ok "$(basename "$out")  ($(du -h "$out" | cut -f1))"
      if (( ARCHIVE )); then
        # Mirror the original's path under the archive root so the tree stays
        # navigable and a mistake is trivially reversible with mv.
        relpath="${f#$ROOT/}"
        dest="$ARCHIVE_DIR/$relpath"
        mkdir -p "$(dirname "$dest")"
        mv -f "$f" "$dest" && c_skip "archived original -> ${dest#$ARCHIVE_DIR/}"
      elif (( REPLACE )); then
        rm -f "$f" && c_skip "removed original $(basename "$f")"
      fi
    else
      rm -f "$part"; failed=$((failed+1))
      c_bad "output failed verification (codec=$newcodec dur=$newdur vs $olddur) -- original untouched"
    fi
  else
    rm -f "$part"; failed=$((failed+1))
    c_bad "ffmpeg failed: $(tail -2 /tmp/nexus-convert-err.log | tr '\n' ' ')"
  fi

  # Claim released only now: a failed file stays claimed for the lifetime of
  # this loop iteration so a sibling instance does not immediately retry the
  # same doomed encode.
  rm -f "$lock"
  trap - EXIT INT TERM
done

# Per-file traps are cleared above; make sure a stray one cannot fire here.
trap - EXIT INT TERM

echo
c_info "Done. converted=$converted failed=$failed skipped=$SKIPPED"
if (( ARCHIVE )); then
  c_info "Originals moved to $ARCHIVE_DIR (delete it once you have spot-checked playback)."
elif (( ! REPLACE )); then
  c_info "Originals kept IN PLACE -- the library will show duplicates until you re-run with --archive or --replace."
fi
