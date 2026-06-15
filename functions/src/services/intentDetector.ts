// ─── Intent detection — deterministic keyword matching ───────────────────────
//
// Used for routing decisions before invoking Claude.
// Fast, zero-latency, no API cost. Claude handles nuanced interpretation.

// ─── Live mode intent ─────────────────────────────────────────────────────────

const LIVE_KEYWORDS = [
  "im live",
  "i'm live",
  "ready now",
  "available now",
  "connect me now",
  "instant match",
  "right now",
  "free right now",
  "i'm free",
  "im free",
  "available tonight",
  "free tonight",
  "ready to meet",
  "let's connect now",
  "lets connect now",
  "go live",
  "live mode",
  "instant",
  "now mode",
  "match me now",
];

export function detectLiveIntent(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return LIVE_KEYWORDS.some((kw) => normalized.includes(kw));
}

// ─── Cancel live mode intent ──────────────────────────────────────────────────

const CANCEL_LIVE_KEYWORDS = [
  "cancel",
  "stop looking",
  "never mind",
  "nevermind",
  "not anymore",
  "not right now",
  "stop live",
  "go offline",
  "forget it",
  "forget the live",
];

export function detectCancelLiveIntent(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return CANCEL_LIVE_KEYWORDS.some((kw) => normalized.includes(kw));
}

// ─── Yes / No intent ──────────────────────────────────────────────────────────

const YES_PATTERNS = [
  /^\s*(yes|yeah|yep|yup|sure|definitely|absolutely|sounds good|i'm in|im in|let's do it|lets do it|ok|okay|y\b|👍)/i,
];

const NO_PATTERNS = [
  /^\s*(no|nah|nope|not interested|pass|no thanks|not right now|skip|n\b|👎)/i,
];

export function detectYesNoIntent(text: string): "yes" | "no" | "ambiguous" {
  for (const pattern of YES_PATTERNS) {
    if (pattern.test(text)) return "yes";
  }
  for (const pattern of NO_PATTERNS) {
    if (pattern.test(text)) return "no";
  }
  return "ambiguous";
}

// ─── Reactivation intent ──────────────────────────────────────────────────────
//
// A member who declined or had a no-fit date asking to bring that pair back.
// Deterministic substring match, same style as detectLiveIntent. Clears the most
// recent block on a match (see handleReactivation in webhooks/sms.ts).

const REACTIVATION_KEYWORDS = [
  "reconsider",
  "changed my mind",
  "change my mind",
  "second chance",
  "another shot",
  "another chance",
  "another go",
  "second meet",
  "second date",
  "reconnect",
  "reactivate",
  "give them another",
];

export function detectReactivationIntent(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return REACTIVATION_KEYWORDS.some((kw) => normalized.includes(kw));
}

// ─── Help intent ──────────────────────────────────────────────────────────────

const HELP_KEYWORDS = ["help", "what can you do", "how does this work", "commands", "options"];

export function detectHelpIntent(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return HELP_KEYWORDS.some((kw) => normalized.includes(kw));
}
