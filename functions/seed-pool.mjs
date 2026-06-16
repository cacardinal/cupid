// Seed a pool of FULLY-ONBOARDED users straight into the emulator, skipping the
// ~8-turn onboarding conversation that dominates a fold's wall time. Lets a fold
// spend its budget on the post-match lifecycle (propose -> date -> debrief ->
// exchange), which is the part we actually need to validate.
//
// Reuses the functions' own getOrCreateUser/updateUser so every record is
// byte-identical to an organically-onboarded user: same phoneHash (hashPhone),
// same encrypted phone_mapping (encryptPhone with process.env.PHONE_ENCRYPTION_KEY).
// Run it with the SAME key the emulator uses (load .env.local; with .secret.local
// present the emulator also resolves to that value, so encrypt/decrypt agree).
//
// Usage (from functions/):
//   node seed-pool.mjs ../sim/personas/personas-mini30.jsonl [N]
// Requires the emulator running on 127.0.0.1:8080 and DEMO_MODE stack up.
import fs from "node:fs";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.GCLOUD_PROJECT ??= "cupid-dating-mvp";
for (const line of fs.readFileSync("./.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const poolPath = process.argv[2];
if (!poolPath) {
  console.error("usage: node seed-pool.mjs <personas.jsonl> [N]");
  process.exit(1);
}
const limit = process.argv[3] ? Number(process.argv[3]) : Infinity;

const admin = (await import("firebase-admin")).default;
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });

const { getOrCreateUser, updateUser } = await import("./lib/services/firestore.js");

const personas = fs
  .readFileSync(poolPath, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .slice(0, limit);

let seeded = 0;
for (const p of personas) {
  const gt = p.groundTruth;
  const { profile } = await getOrCreateUser(p.phone); // creates user + encrypted phone_mapping
  await updateUser(profile.phoneHash, {
    demographics: {
      age: gt.age,
      gender: gt.gender,
      orientation: gt.orientation,
      city: gt.city,
    },
    preferences: {
      ageMin: gt.ageMin,
      ageMax: gt.ageMax,
      genderPreference: gt.genderPreference ?? [],
      relationshipIntent: gt.relationshipIntent,
      dealbreakers: gt.dealbreakers ?? [],
    },
    personality: {
      interests: gt.interests ?? [],
      values: gt.values ?? [],
      humorStyle: gt.humorStyle,
      communicationStyle: gt.communicationStyle,
      wantsKids: gt.wantsKids,
      hasKids: gt.hasKids,
      occupation: gt.occupation,
      education: gt.education,
    },
    onboardingComplete: true,
    onboardingStage: "complete",
    active: true,
  });
  seeded++;
}

console.log(`seeded ${seeded} fully-onboarded users from ${poolPath}`);
process.exit(0);
