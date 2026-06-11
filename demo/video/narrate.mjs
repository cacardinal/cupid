#!/usr/bin/env node
// Generate narration audio per scene.
// Deepgram Aura TTS if a real DEEPGRAM_API_KEY exists; otherwise macOS `say`.
// Outputs: demo/video/out/scene-N.m4a + durations.json

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

// Each scene: text + optional prosody (edge-tts supports per-request rate/pitch;
// word-level inflection comes from punctuation — periods punch, "?" lifts,
// "..." pauses). Cupid is the actor throughout; the stack gets one credit at the end.
export const SCENES = [
  {
    text: "This is Cupid. An A.I. matchmaker you text. No app. No profiles. No swiping. Everything you're about to see is the real system, running end to end: live conversations, a real matching engine, and a real database.",
    rate: "+4%",
  },
  {
    text: "Users just talk. Cupid listens, learns, and quietly builds a structured profile from every message: age, values, interests, dealbreakers. And the reply you're watching? Generated live, right now.",
  },
  {
    text: "Twelve synthetic users, engineered to stress the engine: compatible pairs, borderline cases, and built-in conflicts.",
  },
  {
    text: "Hard filters run first: mutual gender preference, age ranges, location, dealbreakers. Then, weighted compatibility. Relationship intent. Shared interests. Shared values. Personality fit. Maya and Eli? Ninety-three. But look at Tessa and Rob. Near-perfect on paper... except he smokes, and that's her hard no. Blocked. No matter the score.",
    rate: "-3%",
  },
  {
    text: "When both sides say yes, Cupid sends an anonymous video link. Fifteen minutes. First names only. Nobody's number changes hands.",
  },
  {
    text: "They meet face to face... before they share anything else.",
    rate: "-5%",
  },
  {
    text: "Your first introduction is free. After that? You pay per introduction, not per month of swiping. Cupid. Built on Claude, Twilio, Firebase, and Daily.",
    rate: "+3%",
  },
];

function loadDeepgramKey() {
  for (const f of [".env.local", ".env"]) {
    const p = path.join(__dirname, "..", "..", "functions", f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^DEEPGRAM_API_KEY=(.+)$/m);
    // Heuristic: real Deepgram keys are 30+ chars; "stub" is not.
    if (m && m[1].trim().length > 20) return m[1].trim();
  }
  return null;
}

async function deepgramTts(text, outFile, key) {
  const res = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${await res.text()}`);
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
}

function sayTts(text, outFile) {
  const aiff = outFile.replace(/\.m4a$/, ".aiff");
  execFileSync("say", ["-v", "Samantha", "-r", "185", "-o", aiff, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-c:a", "aac", "-b:a", "128k", outFile]);
  fs.unlinkSync(aiff);
}

// Microsoft Edge neural TTS via the edge-tts Python package — free, no key,
// far more natural than macOS compact voices. `pip3 install edge-tts`.
const EDGE_VOICE = "en-US-JennyNeural";

function hasEdgeTts() {
  try {
    execFileSync("python3", ["-m", "edge_tts", "--list-voices"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function edgeTts(scene, outFile) {
  const mp3 = outFile.replace(/\.m4a$/, ".mp3");
  const args = ["-m", "edge_tts", "--voice", EDGE_VOICE];
  if (scene.rate) args.push(`--rate=${scene.rate}`);
  if (scene.pitch) args.push(`--pitch=${scene.pitch}`);
  args.push("--text", scene.text, "--write-media", mp3);
  execFileSync("python3", args);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-c:a", "aac", "-b:a", "128k", outFile]);
  fs.unlinkSync(mp3);
}

function duration(file) {
  return parseFloat(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ]).toString().trim()
  );
}

const key = loadDeepgramKey();
const edge = !key && hasEdgeTts();
console.log(
  `TTS engine: ${key ? "Deepgram Aura" : edge ? `Edge neural (${EDGE_VOICE})` : "macOS say (Samantha)"}`
);

const durations = [];
for (let i = 0; i < SCENES.length; i++) {
  const out = path.join(OUT, `scene-${i + 1}.m4a`);
  if (key) {
    const mp3 = out.replace(/\.m4a$/, ".mp3");
    await deepgramTts(SCENES[i].text, mp3, key);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp3, "-c:a", "aac", out]);
    fs.unlinkSync(mp3);
  } else if (edge) {
    edgeTts(SCENES[i], out);
  } else {
    sayTts(SCENES[i].text, out);
  }
  const d = duration(out);
  durations.push(d);
  console.log(`  scene ${i + 1}: ${d.toFixed(1)}s`);
}

fs.writeFileSync(path.join(OUT, "durations.json"), JSON.stringify(durations));
console.log(`Total narration: ${durations.reduce((a, b) => a + b, 0).toFixed(1)}s`);
