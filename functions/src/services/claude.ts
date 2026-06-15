import Anthropic from "@anthropic-ai/sdk";
import { sanitizeProfileValue } from "./outboundSecurity";
import { normalizeGenderTerm } from "../scheduler/matchingJob";
import { UserProfile, ConversationTurn, OnboardingStage } from "../models/user";
import {
  buildOnboardingSystemPrompt,
  buildMatchProposalPrompt,
  buildPostVideoFollowUpPrompt,
  buildMatchDescription,
  buildVoicedMessagePrompt,
  stripDashes,
} from "../prompts/cupid";

export const MODEL = "claude-sonnet-4-5";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ─── Sim bridge (emulator-only) ───────────────────────────────────────────────
// When CLAUDE_BRIDGE_URL is set, route completions through the local `claude -p`
// bridge (sim/bridge.mjs) instead of the Anthropic API. Identical prompts and
// response parsing; only the serving path differs. Hard-guarded to local dev.

function bridgeUrl(): string | null {
  const url = process.env.CLAUDE_BRIDGE_URL;
  if (!url) return null;
  if (process.env.FUNCTIONS_EMULATOR !== "true" && process.env.DEMO_MODE !== "true") {
    throw new Error("CLAUDE_BRIDGE_URL is set outside the emulator. Refusing.");
  }
  return url;
}

interface CreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Anthropic.MessageParam[];
}

export async function createCompletion(params: CreateParams): Promise<Anthropic.Message> {
  const url = bridgeUrl();
  if (!url) {
    return getClient().messages.create(params as Anthropic.MessageCreateParamsNonStreaming);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, _job: "cupid-engine" }),
  });
  if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
  return (await res.json()) as Anthropic.Message;
}

export interface ClaudeResponse {
  message: string;
  profileUpdates: Record<string, unknown> | null;
  rawResponse: string;
}

// ─── Core conversation turn ───────────────────────────────────────────────────

export async function generateConversationReply(
  userMessage: string,
  history: ConversationTurn[],
  profile: UserProfile,
  stage: OnboardingStage
): Promise<ClaudeResponse> {
  const systemPrompt = buildOnboardingSystemPrompt(profile, stage);

  const messages: Anthropic.MessageParam[] = [
    ...history.map((turn) => ({
      role: turn.role as "user" | "assistant",
      content: turn.content,
    })),
    { role: "user" as const, content: userMessage },
  ];

  const response = await createCompletion({
    // 1024 so the visible reply and the trailing <profile_update> JSON block
    // both fit. At 512 a longer reply consumed the budget before the JSON,
    // truncating the question mid-word (wave 2/3 judge flagged cut-off
    // onboarding questions, which stall the funnel). Output is billed by
    // tokens actually emitted, so the headroom is free unless used.
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const rawText = extractText(response);
  return parseClaudeResponse(rawText);
}

// ─── Match proposal message ───────────────────────────────────────────────────

export async function generateMatchProposal(
  userProfile: UserProfile,
  matchProfile: UserProfile
): Promise<ClaudeResponse> {
  const matchDescription = buildMatchDescription(matchProfile);
  const systemPrompt = buildMatchProposalPrompt(userProfile, matchDescription);

  const response = await createCompletion({
    model: MODEL,
    max_tokens: 256,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: "Generate the match proposal message.",
      },
    ],
  });

  return parseClaudeResponse(extractText(response));
}


// ─── Voiced system message ────────────────────────────────────────────────────
// Generate a system-initiated message (going live, window closed, orientation)
// in Cupid's voice, personalized to the user, instead of a hardcoded string.
// Falls back to a short safe line if the model call fails, so a live-mode flow
// never breaks on a generation error.
export async function generateVoicedMessage(
  userProfile: UserProfile,
  situation: string,
  fallback: string
): Promise<string> {
  try {
    const systemPrompt = buildVoicedMessagePrompt(userProfile, situation);
    const response = await createCompletion({
      model: MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: "user", content: "Write the text now." }],
    });
    const text = parseClaudeResponse(extractText(response)).message.trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

// ─── Friend-mode check-in ─────────────────────────────────────────────────────

export async function generateFriendCheckin(
  userProfile: UserProfile,
  history: ConversationTurn[]
): Promise<ClaudeResponse> {
  const { buildFriendCheckinPrompt } = await import("../prompts/cupid");
  const systemPrompt = buildFriendCheckinPrompt(userProfile);

  const recent = history
    .slice(-8)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  const response = await createCompletion({
    model: MODEL,
    max_tokens: 200,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Recent conversation:\n${recent}\n\nWrite the check-in message now.`,
      },
    ],
  });

  return parseClaudeResponse(extractText(response));
}

// ─── Engagement review: decide whether to reach out ───────────────────────────

import type { NearMatch } from "./nearMatch";
import type { ProfileGap } from "./profileGaps";

export interface DecideFollowUpResult {
  followUp: boolean;
  intent: "rapport" | "deepen" | "reveal_match";
  message: string;
  reason: string;
}

const VALID_INTENTS = new Set(["rapport", "deepen", "reveal_match"]);

/**
 * Ask the model whether to proactively reach out to this member now. Returns a
 * strict, validated decision; the model MAY decline. Fail-closed: any model or
 * parse error returns a decline, never throws. Goes through createCompletion so
 * the sim bridge path is preserved.
 */
export async function decideFollowUp(
  member: UserProfile,
  history: ConversationTurn[],
  nearMatches: NearMatch[],
  gaps: ProfileGap[]
): Promise<DecideFollowUpResult> {
  const decline = (reason: string): DecideFollowUpResult => ({
    followUp: false,
    intent: "rapport",
    message: "",
    reason,
  });

  try {
    const { buildDecideFollowUpPrompt } = await import("../prompts/cupid");
    const systemPrompt = buildDecideFollowUpPrompt(member, history, nearMatches, gaps);
    const response = await createCompletion({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: "Make the decision now. Return only the JSON object." }],
    });

    const raw = extractText(response);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return decline("no_json");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return decline("parse_error");
    }

    if (parsed.followUp !== true) return decline("model_declined");

    const intent = String(parsed.intent ?? "");
    if (!VALID_INTENTS.has(intent)) return decline("invalid_intent");

    const message = stripDashes(String(parsed.message ?? "")).trim();
    if (!message) return decline("empty_message");

    return {
      followUp: true,
      intent: intent as DecideFollowUpResult["intent"],
      message,
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    return decline("error");
  }
}

/**
 * Interpret a member's free-form openness phrase into a conservative list of
 * candidate cities they are open to. Intersects with the supplied candidate list
 * (defensive) and lowercases. Never throws; returns [] on error/uncertainty.
 */
export async function interpretOpenness(
  opennessPhrase: string,
  homeCity: string,
  candidateCities: string[]
): Promise<string[]> {
  if (!opennessPhrase || candidateCities.length === 0) return [];
  try {
    const { buildOpennessInterpretationPrompt } = await import("../prompts/cupid");
    const allowed = new Set(candidateCities.map((c) => c.toLowerCase().trim()));
    const systemPrompt = buildOpennessInterpretationPrompt(opennessPhrase, homeCity, candidateCities);
    const response = await createCompletion({
      model: MODEL,
      max_tokens: 120,
      system: systemPrompt,
      messages: [{ role: "user", content: "Return only the JSON array." }],
    });

    const raw = extractText(response);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((c) => String(c).toLowerCase().trim())
      .filter((c) => c && allowed.has(c));
  } catch {
    return [];
  }
}

// ─── Post-video follow-up ─────────────────────────────────────────────────────

export async function generatePostVideoFollowUp(
  userProfile: UserProfile
): Promise<ClaudeResponse> {
  const systemPrompt = buildPostVideoFollowUpPrompt(userProfile);

  const response = await createCompletion({
    model: MODEL,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: "user", content: "Generate the post-video follow-up message." }],
  });

  return parseClaudeResponse(extractText(response));
}

// ─── Intent detection ─────────────────────────────────────────────────────────

export async function detectIntent(
  message: string
): Promise<"yes" | "no" | "ambiguous"> {
  // Fast path: obvious yes/no answers resolve via keyword patterns —
  // no API latency and no risk of the model over-hedging on a bare "yes".
  const { detectYesNoIntent } = await import("./intentDetector");
  const keywordIntent = detectYesNoIntent(message);
  if (keywordIntent !== "ambiguous") return keywordIntent;

  const response = await createCompletion({
    model: MODEL,
    max_tokens: 16,
    system: `The user was just asked whether they want to meet a potential match. Classify their reply as YES (they want to proceed), NO (they decline), or AMBIGUOUS (genuinely unclear). Enthusiasm, agreement, or interest counts as YES. Reply with exactly one word: YES, NO, or AMBIGUOUS.`,
    messages: [
      {
        role: "user",
        content: `Their reply: "${message}"`,
      },
    ],
  });

  const text = extractText(response).trim().toUpperCase();
  if (text.includes("YES")) return "yes";
  if (text.startsWith("NO")) return "no";
  return "ambiguous";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function parseClaudeResponse(rawText: string): ClaudeResponse {
  const profileUpdateMatch = rawText.match(/<profile_update>([\s\S]*?)<\/profile_update>/);
  let profileUpdates: Record<string, unknown> | null = null;

  if (profileUpdateMatch) {
    try {
      profileUpdates = JSON.parse(profileUpdateMatch[1].trim());
    } catch {
      profileUpdates = null;
    }
  }

  // Strip profile_update blocks from the visible message — including an
  // UNTERMINATED block (max_tokens truncation can cut off the closing tag,
  // which would otherwise leak raw JSON into the user's SMS).
  const messageRaw = rawText
    .replace(/<profile_update>[\s\S]*?<\/profile_update>/g, "")
    .replace(/<profile_update>[\s\S]*$/, "");
  // Brand rule: no em/en dashes in anything Cupid sends. The prompt forbids
  // them but models still slip; enforce deterministically (wave-smoke finding).
  const message = stripDashes(messageRaw).trim();

  return { message, profileUpdates, rawResponse: rawText };
}

// ─── Profile merge helper ─────────────────────────────────────────────────────

// Fields typed as arrays in UserProfile. The model intermittently emits these
// as a scalar or comma-string ("hiking, biking") in a profile_update block,
// which later threw "x.join is not a function" in buildProfileSummary and broke
// every subsequent SMS turn (wave 1-4 funnel root cause). Coerce to an array
// at the write boundary so stored data is always correctly typed.
const ARRAY_PROFILE_FIELDS = new Set([
  "genderPreference",
  "dealbreakers",
  "values",
  "interests",
  "personalityTraits",
]);

function coerceArrayField(key: string, value: unknown): unknown {
  if (!ARRAY_PROFILE_FIELDS.has(key)) return value;
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === "string") {
    arr = value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  } else {
    arr = [value];
  }
  // Canonicalize gender preference vocabulary at write time ("men" -> "man",
  // "women" -> "woman", "any" -> dropped = open) so it matches the singular
  // gender enum the matcher compares against. Matcher also normalizes at read
  // time; this keeps stored data clean going forward.
  if (key === "genderPreference") {
    arr = arr
      .map((g) => normalizeGenderTerm(g))
      .filter((g): g is string => !!g && g !== "any");
  }
  return arr;
}

export function mergeProfileUpdates(
  profile: UserProfile,
  updates: Record<string, unknown> | null
): Partial<UserProfile> {
  if (!updates) return {};

  const merged: Partial<UserProfile> = {};

  if (updates.demographics && typeof updates.demographics === "object") {
    const demo = updates.demographics as Record<string, unknown>;
    merged.demographics = { ...profile.demographics };
    for (const [k, v] of Object.entries(demo)) {
      if (v !== null && v !== undefined) {
        (merged.demographics as Record<string, unknown>)[k] = sanitizeProfileValue(v);
      }
    }
  }

  if (updates.preferences && typeof updates.preferences === "object") {
    const prefs = updates.preferences as Record<string, unknown>;
    merged.preferences = { ...profile.preferences };
    for (const [k, v] of Object.entries(prefs)) {
      if (v !== null && v !== undefined) {
        (merged.preferences as Record<string, unknown>)[k] = sanitizeProfileValue(coerceArrayField(k, v));
      }
    }
  }

  if (updates.personality && typeof updates.personality === "object") {
    const pers = updates.personality as Record<string, unknown>;
    merged.personality = { ...profile.personality };
    for (const [k, v] of Object.entries(pers)) {
      if (v !== null && v !== undefined) {
        (merged.personality as Record<string, unknown>)[k] = sanitizeProfileValue(coerceArrayField(k, v));
      }
    }
  }

  if (updates.onboardingStage && typeof updates.onboardingStage === "string") {
    merged.onboardingStage = updates.onboardingStage as OnboardingStage;
  }

  if (typeof updates.onboardingComplete === "boolean") {
    merged.onboardingComplete = updates.onboardingComplete;
  }

  return merged;
}
