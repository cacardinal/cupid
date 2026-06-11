// Thin REST layer over the local emulators (via Vite proxy — see vite.config.js).

const PROJECT = "cupid-dating-mvp";
const FS_BASE = `/fsdb/v1/projects/${PROJECT}/databases/(default)/documents`;
const FNS_BASE = `/fns/${PROJECT}/us-central1`;
const OWNER = { Authorization: "Bearer owner" }; // emulator-only rules bypass

// ── Firestore value decoding ─────────────────────────────────────────────────

export function decodeValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields ?? {});
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeValue);
  return v;
}

export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = decodeValue(v);
  return out;
}

function decodeDoc(doc) {
  return {
    id: doc.name.split("/").pop(),
    path: doc.name.split("/documents/")[1],
    ...decodeFields(doc.fields),
  };
}

// ── Firestore reads ──────────────────────────────────────────────────────────

export async function listDocs(path, pageSize = 200) {
  const res = await fetch(`${FS_BASE}/${path}?pageSize=${pageSize}`, { headers: OWNER });
  if (!res.ok) throw new Error(`Firestore list ${path}: ${res.status}`);
  const data = await res.json();
  return (data.documents ?? []).map(decodeDoc);
}

export async function getDoc(path) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: OWNER });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get ${path}: ${res.status}`);
  return decodeDoc(await res.json());
}

// ── Firestore writes (demo-only: paywall credit top-up) ─────────────────────

export async function patchUserCredits(phoneHash, credits) {
  const url = `${FS_BASE}/users/${phoneHash}?updateMask.fieldPaths=creditsRemaining`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { creditsRemaining: { integerValue: String(credits) } } }),
  });
  if (!res.ok) throw new Error(`Credit patch failed: ${res.status}`);
}

// ── Cloud Functions ──────────────────────────────────────────────────────────

/** Simulate an inbound SMS from `phone`. Fire-and-forget — state arrives via polling. */
export async function sendInboundSms(phone, body) {
  await fetch(`${FNS_BASE}/smsWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: phone, Body: body }),
  }).catch(() => {}); // 500s with stub Twilio are expected pre-fix; state still lands
}

export async function demoAdmin(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params });
  const res = await fetch(`${FNS_BASE}/demoAdmin?${qs}`, { method: "POST" });
  return res.json();
}

// ── Domain helpers ───────────────────────────────────────────────────────────

export const listUsers = () => listDocs("users");
export const listOutbox = () => listDocs("demo_outbox", 300);
export const listConversation = (hash) => listDocs(`users/${hash}/conversations`, 300);
export const listMatches = (hash) => listDocs(`users/${hash}/matches`, 50);

// SHA-256 phone hash — mirrors functions/src/services/firestore.ts hashPhone()
export async function hashPhone(e164) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e164.trim()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
