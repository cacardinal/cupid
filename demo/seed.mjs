#!/usr/bin/env node
// Seed the Firestore EMULATOR with synthetic Cupid users from personas.json.
//
// Usage (from repo root, with emulators running):
//   node demo/seed.mjs           # add/overwrite synthetic users
//   node demo/seed.mjs --reset   # wipe users/phone_mappings/demo_outbox first
//
// Talks ONLY to the emulator — refuses to run if FIRESTORE_EMULATOR_HOST
// can't be defaulted to localhost.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.join(__dirname, "..", "functions");

// Resolve firebase-admin from functions/node_modules (no separate install).
const require = createRequire(path.join(functionsDir, "package.json"));
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");

// ── Env: load PHONE_ENCRYPTION_KEY from functions/.env(.local) ───────────────

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnvFile(path.join(functionsDir, ".env"));
loadEnvFile(path.join(functionsDir, ".env.local"));

const ENC_KEY_HEX = process.env.PHONE_ENCRYPTION_KEY;
if (!ENC_KEY_HEX || ENC_KEY_HEX.length !== 64) {
  console.error("PHONE_ENCRYPTION_KEY (64-hex) not found in functions/.env");
  process.exit(1);
}

// Emulator only — never touch production.
process.env.FIRESTORE_EMULATOR_HOST ??= "localhost:8080";
if (!/^(localhost|127\.0\.0\.1)/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  console.error("Refusing to seed a non-local Firestore:", process.env.FIRESTORE_EMULATOR_HOST);
  process.exit(1);
}

admin.initializeApp({ projectId: "cupid-dating-mvp" });
const db = admin.firestore();

// ── Phone hashing/encryption — mirrors functions/src/services/firestore.ts ──

const hashPhone = (e164) => crypto.createHash("sha256").update(e164.trim()).digest("hex");

function encryptPhone(phone) {
  const key = Buffer.from(ENC_KEY_HEX, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(phone, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

// ── Reset ────────────────────────────────────────────────────────────────────

async function wipeCollection(name) {
  const docs = await db.collection(name).listDocuments();
  for (const doc of docs) {
    await db.recursiveDelete(doc);
  }
  console.log(`  wiped ${name} (${docs.length} docs)`);
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--reset")) {
    console.log("Resetting collections...");
    for (const col of ["users", "phone_mappings", "demo_outbox"]) {
      await wipeCollection(col);
    }
  }

  const { personas } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "personas.json"), "utf8")
  );

  const now = Date.now();

  for (const p of personas) {
    const phoneHash = hashPhone(p.phone);
    const createdAt = Timestamp.fromMillis(now - 3 * 24 * 60 * 60 * 1000); // "joined" 3 days ago

    const profile = {
      phoneHash,
      createdAt,
      updatedAt: Timestamp.fromMillis(now - 60 * 60 * 1000),
      onboardingComplete: true,
      onboardingStage: "complete",
      demographics: p.profile.demographics,
      preferences: p.profile.preferences,
      personality: p.profile.personality,
      active: true,
      totalMatches: 0,
      creditsRemaining: p.creditsRemaining,
      testUser: true,
      liveStatus: "offline",
    };

    const batch = db.batch();
    batch.set(db.collection("users").doc(phoneHash), profile);
    batch.set(db.collection("phone_mappings").doc(phoneHash), {
      encryptedPhone: encryptPhone(p.phone),
      createdAt,
    });
    await batch.commit();

    // Conversation history — staggered timestamps over their "3 days"
    const convCol = db.collection("users").doc(phoneHash).collection("conversations");
    const existing = await convCol.listDocuments();
    for (const doc of existing) await doc.delete();

    let t = now - 3 * 24 * 60 * 60 * 1000;
    for (const turn of p.conversation) {
      t += 2 * 60 * 1000; // 2 minutes apart
      await convCol.add({
        role: turn.role,
        content: turn.content,
        timestamp: Timestamp.fromMillis(t),
        channel: "sms",
      });
    }

    console.log(`  seeded ${p.name.padEnd(8)} ${p.phone}  hash=${phoneHash.slice(0, 12)}…  credits=${p.creditsRemaining}`);
  }

  console.log(`\nDone: ${personas.length} synthetic users seeded.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
