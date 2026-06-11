import * as functions from "firebase-functions";

// Outbound allowlist: the deterministic anti-phishing layer. Even if the model
// is successfully prompt-injected (e.g. a poisoned profile field landing in
// another user's match proposal), no URL or phone number leaves the system
// unless it is ours or explicitly allowed by the calling flow. This runs at the
// sendSms choke point, so it covers model output AND hardcoded strings.

const ALLOWED_HOSTS = [
  "textcupid.app",
  "www.textcupid.app",
  "heycupid.app",
  "textcupid.daily.co",
  "us-central1-cupid-dating-mvp.cloudfunctions.net",
];

function isLocalDev(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || process.env.DEMO_MODE === "true";
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  if (ALLOWED_HOSTS.includes(h)) return true;
  if (h.endsWith(".daily.co")) return true; // video rooms
  if (isLocalDev() && (h === "localhost" || h.startsWith("localhost:") || h.startsWith("127.0.0.1"))) {
    return true; // demo harness fake rooms (http://localhost:5180/video/...)
  }
  return false;
}

// Protocol URLs, www-prefixed, and bare domains with common TLDs. Bare-domain
// matching is deliberately narrow (TLD list) to avoid eating normal prose.
const URL_RE =
  /\bhttps?:\/\/[^\s]+|\bwww\.[a-z0-9-]+(?:\.[a-z]{2,})+(?:\/[^\s]*)?|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|app|io|co|me|info|biz|xyz|link|club|online|site|top)(?:\/[^\s]*)?/gi;

// US phone shapes: +1 prefixed, parenthesized area code, or 10 digits with
// separators. Plain 10-digit runs without separators are intentionally NOT
// matched (ages, zip+4s, etc. create false positives; injection payloads that
// survive as unformatted digit runs don't tap-to-dial on modern phones anyway).
const PHONE_RE =
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|\+1\d{10}/g;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function urlHost(match: string): string {
  try {
    const withProto = /^https?:\/\//i.test(match) ? match : `https://${match}`;
    return new URL(withProto).hostname;
  } catch {
    return "";
  }
}

export interface OutboundScrubResult {
  body: string;
  removedUrls: string[];
  removedPhones: string[];
}

/**
 * Strips non-allowlisted URLs and phone numbers from an outbound message.
 * `allowPhones` lets explicit flows (contact exchange) pass a specific number.
 * Cupid's own number always passes.
 */
export function scrubOutbound(body: string, allowPhones: string[] = []): OutboundScrubResult {
  const allowed = new Set(
    // Cupid's own number passes always (env + hardcoded fallback used in copy)
    [process.env.TWILIO_PHONE_NUMBER ?? "", "+13143777361", ...allowPhones]
      .map(normalizePhone)
      .filter(Boolean)
  );
  const removedUrls: string[] = [];
  const removedPhones: string[] = [];

  let out = body.replace(URL_RE, (m) => {
    if (hostAllowed(urlHost(m))) return m;
    removedUrls.push(m);
    return "[link removed]";
  });

  out = out.replace(PHONE_RE, (m) => {
    if (allowed.has(normalizePhone(m))) return m;
    removedPhones.push(m);
    return "[number removed]";
  });

  if (removedUrls.length || removedPhones.length) {
    functions.logger.warn("Outbound scrub removed content", {
      urls: removedUrls,
      phones: removedPhones.map((p) => `...${normalizePhone(p).slice(-4)}`),
    });
  }
  return { body: out, removedUrls, removedPhones };
}

const PROFILE_FIELD_MAX = 120;

/**
 * Hygiene for extracted profile values: profile fields are user-controlled
 * content that later reaches OTHER users (match proposals), so they may never
 * carry contact vectors. Strips ALL URLs and phone shapes (no allowlist) and
 * caps length.
 */
export function sanitizeProfileText(value: string): string {
  return value
    .replace(URL_RE, "")
    .replace(PHONE_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, PROFILE_FIELD_MAX);
}

export function sanitizeProfileValue(v: unknown): unknown {
  if (typeof v === "string") return sanitizeProfileText(v);
  if (Array.isArray(v)) {
    return v
      .slice(0, 20)
      .map((x) => (typeof x === "string" ? sanitizeProfileText(x) : x))
      .filter((x) => x !== "");
  }
  return v;
}
