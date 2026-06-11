import * as functions from "firebase-functions";
import Anthropic from "@anthropic-ai/sdk";
import { Timestamp } from "firebase-admin/firestore";
import { UserProfile, ConversationTurn } from "../models/user";
import { createCompletion, MODEL } from "./claude";
import { updateUser, getConversationTurnCount } from "./firestore";

// ─── Narrative memory layer ───────────────────────────────────────────────────
//
// Third memory layer alongside episodic (rolling 40-turn window) and distilled
// (extracted profile fields). A running 2-4 sentence summary of who this person
// is, their story, in-flight life threads, and their emotional arc with Cupid.
// Internal context only; the narrative is NEVER sent to the user directly.

/** Refresh every 20 turns so material never scrolls past the 40-turn window
 *  unsummarized. Skip very early conversations (not enough signal yet). */
const NARRATIVE_REFRESH_INTERVAL = 20;
const NARRATIVE_MIN_TURNS = 12;

/** How many of the OLDEST turns in the current window feed each refresh.
 *  These are the turns about to scroll out of episodic memory. */
const NARRATIVE_SOURCE_TURNS = 24;

export function shouldUpdateNarrative(
  profile: UserProfile,
  totalTurnCount: number
): boolean {
  if (totalTurnCount < NARRATIVE_MIN_TURNS) return false;
  return (
    totalTurnCount - (profile.narrativeTurnCount ?? 0) >= NARRATIVE_REFRESH_INTERVAL
  );
}

export function buildNarrativeSystemPrompt(oldNarrative: string | undefined): string {
  return `You maintain a running memory summary for Cupid, an AI matchmaker who texts with people. You will receive the previous summary (if any) and a transcript of older conversation turns that are about to scroll out of short-term memory.

Write an updated summary of who this person is. Rules:
- 2 to 4 sentences, third person, plain prose. No headers, no lists, no quotes.
- Concrete specifics over adjectives. "Training for the Chicago marathon in October" beats "athletic and driven."
- Capture their story, in-flight life threads (events coming up, ongoing stresses, projects), and their emotional arc with Cupid (warming up, guarded, playful, frustrated).
- Carry forward still-relevant threads from the previous summary. Drop threads that are clearly resolved or stale.
- Never use em dashes or en dashes. Use periods or commas.
- Output ONLY the summary text, nothing else.

Previous summary: ${oldNarrative && oldNarrative.trim() ? oldNarrative.trim() : "(none yet, this is the first summary)"}`;
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Regenerate and persist the user's narrative summary.
 * Failures log and swallow; this must never break the conversation flow.
 */
export async function updateNarrative(
  phoneHash: string,
  profile: UserProfile,
  history: ConversationTurn[],
  totalTurnCount: number
): Promise<void> {
  try {
    const source = history.slice(0, NARRATIVE_SOURCE_TURNS);
    if (source.length === 0) return;

    const transcript = source
      .map((t) => `${t.role === "user" ? "Them" : "Cupid"}: ${t.content}`)
      .join("\n");

    const response = await createCompletion({
      model: MODEL,
      max_tokens: 200,
      system: buildNarrativeSystemPrompt(profile.narrative),
      messages: [
        {
          role: "user",
          content: `Older conversation turns:\n${transcript}\n\nWrite the updated summary now.`,
        },
      ],
    });

    // Defensive cleanup: narrative gets injected into future prompts the model
    // might echo, so enforce the brand-wide no em/en dash rule deterministically.
    const narrative = extractText(response)
      .replace(/\s*[—–]\s*/g, ", ")
      .trim();
    if (!narrative) return;

    await updateUser(phoneHash, {
      narrative,
      narrativeUpdatedAt: Timestamp.now(),
      narrativeTurnCount: totalTurnCount,
    });

    functions.logger.info("Narrative updated", {
      user: phoneHash.slice(0, 8),
      turnCount: totalTurnCount,
    });
  } catch (err) {
    functions.logger.error("Narrative update failed (conversation unaffected)", err);
  }
}

/**
 * Fire-and-forget entry point wired into the SMS conversation path AFTER the
 * reply is sent. Counts total turns (cheap count() aggregate), checks the
 * refresh thresholds, and refreshes the narrative when due. Never throws.
 */
export async function maybeUpdateNarrative(
  phoneHash: string,
  profile: UserProfile,
  history: ConversationTurn[]
): Promise<void> {
  try {
    const totalTurnCount = await getConversationTurnCount(phoneHash);
    if (!shouldUpdateNarrative(profile, totalTurnCount)) return;
    await updateNarrative(phoneHash, profile, history, totalTurnCount);
  } catch (err) {
    functions.logger.error("Narrative check failed (conversation unaffected)", err);
  }
}
