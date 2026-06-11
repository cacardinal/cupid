#!/usr/bin/env node
// Generate N synthetic STL personas with census-weighted ground truth + haiku voice pass.
// Usage: node sim/personas/generate.mjs --count 1000 --seed 42 [--no-flavor]
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const CENSUS = JSON.parse(fs.readFileSync(path.join(DIR, "..", "census", "stl-demographics.json")));
const args = Object.fromEntries(process.argv.slice(2).map((a,i,arr)=>a.startsWith("--")?[a.slice(2),arr[i+1]&&!arr[i+1].startsWith("--")?arr[i+1]:true]:[]).filter(Boolean));
const COUNT = parseInt(args.count ?? "1000"), SEED = parseInt(args.seed ?? "42");
const THIRSTY_RATE = parseFloat(args.thirsty ?? "0.08"), FREELOADER_RATE = parseFloat(args.freeloader ?? "0.05");
const BRIDGE = process.env.BRIDGE_URL ?? "http://127.0.0.1:5599";

let s = SEED >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (w) => { const r = rnd(); let c = 0; for (const [k, v] of Object.entries(w)) { c += v; if (r <= c) return k; } return Object.keys(w).pop(); };
const pickN = (arr, n) => { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; };

const INTERESTS = ["Cardinals games","Blues hockey","Forest Park runs","Tower Grove farmers market","craft beer","BBQ","live music at Off Broadway","hiking Castlewood","cycling Katy Trail","yoga","CrossFit","F3 workouts","board games","trivia nights","cooking","baking","thrifting","art museum","Botanical Garden","bouldering","kayaking","pickleball","volunteering","gardening","concerts at the Pageant","jazz at the Bistro","reading","podcasts","photography","tattoos","karaoke","soccer (CITY SC)","fishing","camping","video games","anime","D&D","wine tasting in Augusta","food trucks","Cherokee Street antiques"];
const VALUES = ["honesty","loyalty","family","faith","ambition","kindness","humor","adventure","stability","independence","creativity","health","growth","community","authenticity"];
const HUMOR = {dry:0.2,sarcastic:0.22,silly:0.18,witty:0.2,deadpan:0.1,none:0.1};
const COMMS = {texter:0.45,caller:0.1,"in-person":0.15,mixed:0.3};
const DEALBREAKERS = ["smoking","doesn't want kids","wants kids","heavy drinking","no ambition"];

function genderPref(sex, ori) {
  if (ori === "straight") return [sex === "man" ? "woman" : "man"];
  if (ori === "gay") return ["man"]; if (ori === "lesbian") return ["woman"];
  return ["man", "woman"];
}
function ageFromBand(b) { const [lo, hi] = b.split("-").map(Number); return lo + Math.floor(rnd() * (hi - lo + 1)); }

const personas = [];
for (let i = 0; i < COUNT; i++) {
  const band = pick(CENSUS.ageBands), sex = pick(CENSUS.sex), ori = pick(CENSUS.orientation);
  const age = ageFromBand(band);
  const intent = pick(CENSUS.intentByAge[band]);
  const p = {
    id: `sim-${String(i).padStart(4, "0")}`,
    phone: `+1314${String(6000000 + i).padStart(7, "0")}`,
    groundTruth: {
      age, gender: sex === "woman" ? "woman" : "man", orientation: ori,
      city: "st. louis", neighborhood: CENSUS.neighborhoods[Math.floor(rnd() * CENSUS.neighborhoods.length)],
      race: pick(CENSUS.raceEthnicity), education: pick(CENSUS.education), occupation: pick(CENSUS.occupations),
      relationshipIntent: intent, genderPreference: genderPref(sex === "woman" ? "woman" : "man", ori),
      ageMin: Math.max(21, age - (3 + Math.floor(rnd() * 5))), ageMax: age + (3 + Math.floor(rnd() * 7)),
      interests: pickN(INTERESTS, 3 + Math.floor(rnd() * 3)), values: pickN(VALUES, 2 + Math.floor(rnd() * 2)),
      humorStyle: pick(HUMOR), communicationStyle: pick(COMMS),
      wantsKids: age < 30 ? rnd() < 0.5 : rnd() < 0.6, hasKids: age > 30 ? rnd() < 0.35 : rnd() < 0.1,
      dealbreakers: rnd() < 0.25 ? [DEALBREAKERS[Math.floor(rnd() * DEALBREAKERS.length)]] : [],
      smoker: rnd() < 0.12,
    },
    behavior: {
      msgLen: pick({ short: 0.4, medium: 0.45, long: 0.15 }),
      lowercase: rnd() < 0.45, typoRate: +(rnd() * 0.08).toFixed(3), emojiRate: +(rnd() * 0.5).toFixed(2),
      latencyMinVirtual: [5, 20, 60, 240][Math.floor(rnd() * 4)],
      dropoutHazard: +(0.01 + rnd() * 0.05).toFixed(3),
      agreeableness: +(0.3 + rnd() * 0.6).toFixed(2),
      guardedness: +(rnd()).toFixed(2),
    },
  };
  // Adversarial archetypes (wave-3+): thirsty = wants a hookup NOW (legitimate
  // use, must be matched consent-to-consent, never judged); freeloader = treats
  // Cupid as a free general-purpose chatbot (must be redirected + capped).
  const ar = rnd();
  if (ar < THIRSTY_RATE) {
    p.archetype = "thirsty";
    p.groundTruth.relationshipIntent = "casual";
    p.behavior.latencyMinVirtual = 5;
    p.behavior.agreeableness = +(0.8 + rnd() * 0.15).toFixed(2);
    p.behavior.dropoutHazard = +(0.005 + rnd() * 0.02).toFixed(3);
  } else if (ar < THIRSTY_RATE + FREELOADER_RATE) {
    p.archetype = "freeloader";
    p.behavior.dropoutHazard = 0.002; // they don't leave, that's the problem
    p.behavior.latencyMinVirtual = 5;
    p.freeloaderAsks = pickN([
      "write my resume bullet points",
      "help me draft an email to my landlord",
      "explain how mortgage rates work",
      "give me a meal plan for the week",
      "write a python script that renames files",
      "summarize the plot of a TV show",
      "help with my fantasy football lineup",
      "translate a paragraph into Spanish",
      "give me workout programming for the month",
      "act as my free therapist and analyze my childhood",
    ], 4);
  } else {
    p.archetype = "standard";
  }
  personas.push(p);
}
console.log(`archetypes: ${personas.filter(p=>p.archetype==="thirsty").length} thirsty, ${personas.filter(p=>p.archetype==="freeloader").length} freeloader, ${personas.filter(p=>p.archetype==="standard").length} standard`);

// Haiku flavor pass (names + backstory + voice samples), batched
async function flavor() {
  const B = 20;
  for (let i = 0; i < personas.length; i += B) {
    const batch = personas.slice(i, i + B);
    const prompt = `For each numbered person below, invent: a realistic first name (match the demographic), a 2-sentence backstory grounded in St. Louis, and one example text message in THEIR texting voice. Reply as JSON array: [{"i":0,"name":"...","backstory":"...","sampleText":"..."}]. No commentary.\n\n` +
      batch.map((p, j) => `${j}. ${p.groundTruth.age}yo ${p.groundTruth.gender}, ${p.groundTruth.race}, ${p.groundTruth.occupation}, ${p.groundTruth.neighborhood}, into ${p.groundTruth.interests.slice(0,2).join(" + ")}, ${p.behavior.lowercase ? "types lowercase" : "normal caps"}, ${p.behavior.msgLen} messages`).join("\n");
    const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "haiku", max_tokens: 4000, messages: [{ role: "user", content: prompt }], _job: "sim-personas" }) });
    if (!res.ok) { console.error("flavor batch failed", i, await res.text()); continue; }
    const text = (await res.json()).content[0].text;
    try {
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);
      for (const f of arr) { const p = batch[f.i]; if (p) { p.name = f.name; p.backstory = f.backstory; p.sampleText = f.sampleText; } }
    } catch (e) { console.error("flavor parse failed batch", i); }
    process.stdout.write(`\rflavored ${Math.min(i + B, personas.length)}/${personas.length}`);
  }
  console.log();
}

if (!args["no-flavor"]) await flavor();
for (const p of personas) { p.name ??= "Alex"; p.backstory ??= ""; p.sampleText ??= "hey"; }
const out = path.join(DIR, `personas-${COUNT}.jsonl`);
fs.writeFileSync(out, personas.map((p) => JSON.stringify(p)).join("\n"));
console.log(`wrote ${out}`);
