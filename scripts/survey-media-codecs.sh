#!/usr/bin/env bash
# Read-only survey: which files in a media root would need transcoding to
# direct-play in a browser, and which already play as-is.
#
# Direct play needs H.264 8-bit video + AAC/MP3 audio in MP4/MKV. Anything
# else (HEVC, 10-bit, AC3/EAC3/DTS/TrueHD) forces a live transcode, which is
# what makes playback stall when the file is also being read over a network
# mount.
#
# Usage: scripts/survey-media-codecs.sh [media_root]
set -uo pipefail

ROOT="${1:-/home/moh/nexus-media}"
[ -d "$ROOT" ] || { echo "No such directory: $ROOT" >&2; exit 1; }

command -v ffprobe >/dev/null || { echo "ffprobe not installed" >&2; exit 1; }

probe_one() {
  local f="$1"
  # One ffprobe call, first video + first audio stream.
  local v a
  v=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt \
        -of csv=p=0 "$f" 2>/dev/null | head -1)
  a=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name \
        -of csv=p=0 "$f" 2>/dev/null | head -1)
  local size_mb
  size_mb=$(( $(stat -c%s "$f" 2>/dev/null || echo 0) / 1048576 ))

  local vcodec="${v%%,*}" pixfmt="${v##*,}"
  local needs=""
  case "$vcodec" in
    h264|avc1) [[ "$pixfmt" == *10le* || "$pixfmt" == *10be* ]] && needs="video(10bit)" ;;
    *)         needs="video($vcodec)" ;;
  esac
  case "$a" in
    aac|mp3|opus|vorbis) ;;
    *) needs="${needs:+$needs+}audio($a)" ;;
  esac

  printf '%s\t%s\t%s\t%s\t%s\n' "${needs:-DIRECT}" "$vcodec" "$a" "$size_mb" "$f"
}
export -f probe_one

echo "Surveying $ROOT ..." >&2
mapfile -t FILES < <(find "$ROOT" -type f \
  \( -iname '*.mkv' -o -iname '*.mp4' -o -iname '*.avi' -o -iname '*.m4v' -o -iname '*.mov' -o -iname '*.webm' \) 2>/dev/null)
echo "Found ${#FILES[@]} video file(s). Probing..." >&2

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf '%s\0' "${FILES[@]}" | xargs -0 -P 8 -I{} bash -c 'probe_one "$@"' _ {} > "$TMP"

echo
echo "=================== SUMMARY ==================="
direct=$(grep -c '^DIRECT' "$TMP" || true)
total=$(wc -l < "$TMP")
echo "Total files:            $total"
echo "Already direct-play:    $direct"
echo "Need conversion:        $(( total - direct ))"
echo
echo "--- size needing conversion ---"
awk -F'\t' '$1 != "DIRECT" { s += $4 } END { printf "  %.1f GB\n", s/1024 }' "$TMP"
echo
echo "--- video codecs present ---"
awk -F'\t' '{ print $2 }' "$TMP" | sort | uniq -c | sort -rn
echo
echo "--- audio codecs present ---"
awk -F'\t' '{ print $3 }' "$TMP" | sort | uniq -c | sort -rn
echo
echo "--- reason for conversion ---"
awk -F'\t' '$1 != "DIRECT" { print $1 }' "$TMP" | sort | uniq -c | sort -rn
echo
echo "Full per-file report written to: ${REPORT:=/tmp/media-codec-survey.tsv}"
cp "$TMP" "$REPORT"
