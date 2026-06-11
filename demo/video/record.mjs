#!/usr/bin/env node
// Record the demo scenes with Playwright (one webm clip per scene).
// Prereqs: emulators running (DEMO_MODE), fresh seed, harness on :5180,
// and `npx playwright install chromium` done in demo/app.
//
// Resolves playwright from demo/app/node_modules.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, "..", "app", "package.json"));
const { chromium } = require("playwright");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const HARNESS = "http://localhost:5180";
const FS_BASE = "http://127.0.0.1:8080/v1/projects/cupid-dating-mvp/databases/(default)/documents";

async function latestVideoLink() {
  const res = await fetch(`${FS_BASE}/demo_outbox?pageSize=300`, {
    headers: { Authorization: "Bearer owner" },
  });
  const docs = (await res.json()).documents ?? [];
  const links = docs
    .map((d) => ({
      t: d.fields.sentAt.timestampValue,
      m: d.fields.body.stringValue.match(/http:\/\/localhost:5180\/video\/(\S+)/),
    }))
    .filter((x) => x.m)
    .sort((a, b) => a.t.localeCompare(b.t));
  return links.at(-1)?.m[0] ?? null;
}

const browser = await chromium.launch();

let sceneNum = 0;
async function scene(actions) {
  sceneNum++;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  try {
    await actions(page);
  } catch (err) {
    console.error(`  scene ${sceneNum} action error (continuing): ${err.message}`);
  }
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  const dest = path.join(OUT, `scene-${sceneNum}.webm`);
  fs.renameSync(webm, dest);
  console.log(`  scene ${sceneNum} recorded`);
}

console.log("Recording scenes…");

// 1 — Phones tab with seeded conversations
await scene(async (page) => {
  await page.goto(HARNESS);
  await page.waitForSelector(".bubble", { timeout: 15000 });
  await page.waitForTimeout(9000);
});

// 2 — live Claude reply for Maya
await scene(async (page) => {
  await page.goto(HARNESS);
  await page.waitForSelector(".bubble", { timeout: 15000 });
  const input = page.getByRole("textbox", { name: "Text Cupid…" }).first();
  await input.click();
  await input.pressSequentially("Oh and I'd love someone who can make me laugh on a bad day", { delay: 35 });
  await input.press("Enter");
  // Wait for the live assistant reply (typing dots → new received bubble)
  const before = await page.locator(".bubble.received").count();
  await page
    .waitForFunction(
      (n) => document.querySelectorAll(".bubble.received:not(.typing)").length > n,
      before,
      { timeout: 45000 }
    )
    .catch(() => {});
  await page.waitForTimeout(3500);
});

// 3 — dashboard user grid
await scene(async (page) => {
  await page.goto(HARNESS);
  await page.click("text=🧠 Matchmaker");
  await page.waitForSelector(".user-card", { timeout: 15000 });
  await page.waitForTimeout(6000);
});

// 4 — run nightly matching (long Claude wait becomes a timelapse in assembly)
await scene(async (page) => {
  await page.goto(HARNESS);
  await page.click("text=🧠 Matchmaker");
  await page.waitForSelector(".run-btn", { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.click(".run-btn");
  await page.waitForSelector(".run-summary", { timeout: 180000 });
  await page.waitForTimeout(6000);
});

// 5 — both reply yes, video link arrives
await scene(async (page) => {
  await page.goto(HARNESS);
  await page.waitForSelector(".bubble", { timeout: 15000 });
  const inputs = page.getByRole("textbox", { name: "Text Cupid…" });
  await inputs.first().click();
  await inputs.first().pressSequentially("yes!", { delay: 50 });
  await inputs.first().press("Enter");
  await page.waitForTimeout(4000);
  await inputs.nth(1).click();
  await inputs.nth(1).pressSequentially("yes, set it up", { delay: 50 });
  await inputs.nth(1).press("Enter");
  // Wait for the video link bubble on either phone
  await page
    .waitForFunction(
      () => [...document.querySelectorAll(".bubble.received a")].some((a) => a.href.includes("/video/")),
      { timeout: 60000 }
    )
    .catch(() => {});
  await page.waitForTimeout(4000);
});

// 6 — the mock video room
await scene(async (page) => {
  const link = await latestVideoLink();
  if (!link) throw new Error("no video link found in outbox");
  await page.goto(link);
  await page.waitForSelector(".video-avatar", { timeout: 15000 });
  await page.waitForTimeout(6500);
});

// 7 — Sam's paywall
await scene(async (page) => {
  await page.goto(HARNESS);
  await page.waitForSelector(".phone-controls select", { timeout: 15000 });
  await page.locator(".phone-controls select").first().selectOption({ label: "Sam · +13145550106" });
  await page.waitForTimeout(2500);
  await page.locator(".credits-pill").first().click();
  await page.waitForSelector(".pay-btn", { timeout: 10000 });
  await page.waitForTimeout(2500);
  await page.click(".pay-btn");
  await page.waitForSelector(".pay-success", { timeout: 15000 });
  await page.waitForTimeout(3500);
});

await browser.close();
console.log("All scenes recorded.");
