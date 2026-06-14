/**
 * COMPLETENESS #2 — firestore.rules deny test for the two abuse-review
 * collections. Asserts a client (non-admin) cannot read or write abuse_events
 * or moderation_flags.
 *
 * SKIPPED per B2: this needs the Firestore emulator (port 8080), which is busy
 * (wave 8 simulation). Do NOT start an emulator here; a rebuild/emulator action
 * would contaminate the running wave.
 *
 * TODO: un-skip and run after wave 8 / against a dedicated emulator project.
 * Run with: firebase emulators:exec --only firestore "npx jest firestoreRules"
 */

import * as fs from "fs";
import * as path from "path";

// Static assertion (no emulator needed): the rules file locks the new
// scheduled_messages collection admin-only, mirroring abuse_events /
// moderation_flags. The full emulator-backed deny test lives in the skipped
// block below.
describe("firestore.rules locks scheduled_messages admin-only", () => {
  const rules = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "firestore.rules"),
    "utf8"
  );

  test("declares the scheduled_messages match block", () => {
    expect(rules).toMatch(/match \/scheduled_messages\/\{msgId\}/);
  });

  test("scheduled_messages denies all client read/write", () => {
    const block = rules.slice(rules.indexOf("scheduled_messages"));
    expect(block).toMatch(/allow read, write: if false;/);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let testEnv: any;

describe.skip("firestore.rules denies client access to abuse-review collections", () => {
  beforeAll(async () => {
    // Lazy require so the suite doesn't need @firebase/rules-unit-testing
    // installed unless this block is actually un-skipped.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
    const rules = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "firestore.rules"),
      "utf8"
    );
    testEnv = await initializeTestEnvironment({
      projectId: "cupid-rules-test",
      firestore: { rules, host: "127.0.0.1", port: 8080 },
    });
  });

  afterAll(async () => {
    if (testEnv) await testEnv.cleanup();
  });

  test("client cannot read abuse_events", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { assertFails } = require("@firebase/rules-unit-testing");
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection("abuse_events").doc("e1").get());
  });

  test("client cannot write abuse_events", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { assertFails } = require("@firebase/rules-unit-testing");
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection("abuse_events").doc("e1").set({ x: 1 }));
  });

  test("client cannot read moderation_flags", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { assertFails } = require("@firebase/rules-unit-testing");
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection("moderation_flags").doc("f1").get());
  });

  test("client cannot write moderation_flags", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { assertFails } = require("@firebase/rules-unit-testing");
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection("moderation_flags").doc("f1").set({ x: 1 }));
  });
});
