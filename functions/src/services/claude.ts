import Anthropic from "@anthropic-ai/sdk";
import { sanitizeProfileValue } from "./outboundSecurity";
import { UserProfile, ConversationTurn, OnboardingStage } from "../models/user";
import {
  buildOnboardingSystemPrompt,
  buildMatchProposalPrompt,
  buildPostVideoFollowUpPrompt,
  buildMatchDescription,
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
  const message = rawText
    .replace(/<profile_update>[\s\S]*?<\/profile_update>/g, "")
    .replace(/<profile_update>[\s\S]*$/, "")
    // Brand rule: no em/en dashes in anything Cupid sends. The prompt forbids
    // them but models still slip; enforce deterministically (wave-smoke finding).
    .replace(/\s*[—–]\s*/g, ", ")
    .trim();

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
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [value];
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
