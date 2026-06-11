#!/bin/bash
# Assemble the Cupid demo video.
# Prereqs: emulators running with DEMO_MODE, harness on :5180,
#          playwright chromium installed in demo/app.
# Usage: bash demo/video/build.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT=out
mkdir -p "$OUT"

echo "── 1/4 Reset seed (fresh cooldowns so matching runs live) ──"
node ../seed.mjs --reset

echo "── 2/4 Narration ──"
node narrate.mjs

echo "── 3/4 Record scenes ──"
node record.mjs

echo "── 4/4 Assemble ──"
DUR=$(cat "$OUT/durations.json")
N=$(node -e "console.log(JSON.parse('$DUR').length)")

CONCAT_FILE="$OUT/concat.txt"
> "$CONCAT_FILE"

for i in $(seq 1 "$N"); do
  AUDIO_LEN=$(node -e "console.log(JSON.parse('$DUR')[$i-1])")
  VID="$OUT/scene-$i.webm"
  VID_LEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VID")
  # Fit video to narration length: speed up if longer, freeze last frame if shorter.
  RATIO=$(node -e "console.log(($AUDIO_LEN/$VID_LEN).toFixed(6))")
  ffmpeg -y -loglevel error -i "$VID" -i "$OUT/scene-$i.m4a" \
    -filter_complex "[0:v]setpts=${RATIO}*PTS,fps=30,tpad=stop_mode=clone:stop_duration=10[v]" \
    -map "[v]" -map 1:a -t "$AUDIO_LEN" \
    -c:v libx264 -preset fast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 128k \
    "$OUT/clip-$i.mp4"
  echo "file 'clip-$i.mp4'" >> "$CONCAT_FILE"
  echo "  clip $i: video ${VID_LEN%.*}s → ${AUDIO_LEN%.*}s"
done

ffmpeg -y -loglevel error -f concat -safe 0 -i "$CONCAT_FILE" -c copy "$OUT/cupid-demo.mp4"

# Mix in background music if a track exists (assets/cupid-music.mp3, from Udio).
# Sidechain ducking keeps the bed under the narration; loops + fades to fit.
MUSIC=assets/cupid-music.mp3
if [ -f "$MUSIC" ]; then
  TOTAL=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/cupid-demo.mp4")
  FADE_START=$(node -e "console.log(($TOTAL - 4).toFixed(2))")
  ffmpeg -y -loglevel error -i "$OUT/cupid-demo.mp4" -stream_loop -1 -i "$MUSIC" -filter_complex \
    "[1:a]atrim=0:${TOTAL},asetpts=PTS-STARTPTS,volume=0.40[music]; \
     [0:a]asplit=2[vo][sc]; \
     [music][sc]sidechaincompress=threshold=0.02:ratio=6:attack=80:release=500[ducked]; \
     [ducked]afade=t=in:st=0:d=1.5,afade=t=out:st=${FADE_START}:d=4[m2]; \
     [vo][m2]amix=inputs=2:duration=first:normalize=0[out]" \
    -map 0:v -map "[out]" -c:v copy -c:a aac -b:a 160k "$OUT/cupid-demo-music.mp4"
  mv "$OUT/cupid-demo-music.mp4" "$OUT/cupid-demo.mp4"
  echo "  music bed mixed in ($MUSIC)"
fi

mkdir -p ../../website/assets
cp "$OUT/cupid-demo.mp4" ../../website/assets/cupid-demo.mp4

echo "Done: $OUT/cupid-demo.mp4 (also copied to website/assets/)"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/cupid-demo.mp4" | xargs -I{} echo "Total length: {}s"
