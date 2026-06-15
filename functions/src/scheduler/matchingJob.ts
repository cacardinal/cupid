import { UserProfile } from "../models/user";

// ─── Compatibility scoring ────────────────────────────────────────────────────

export type BlockingFilter = "gender" | "age" | "location" | "dealbreaker";

export interface CompatibilityResult {
  score: number;         // 0-100
  passed: boolean;       // false = dealbreaker eliminated pair
  reasons: string[];     // Human-readable reasons (for debugging)
  // Set ONLY when passed === false; names the SINGLE hard filter that eliminated
  // the pair. If multiple would fail, the FIRST evaluated wins in this order:
  // gender, age, location, dealbreaker.
  blockingFilter?: BlockingFilter;
  // Set when passed === true: scored-low dimensions whose normalized sub-score
  // was < 0.4. For near-match question targeting.
  softGaps?: string[];
}

// Normalized sub-score threshold below which a passing dimension is a "soft gap".
const SOFT_GAP_THRESHOLD = 0.4;

export function computeCompatibility(
  a: UserProfile,
  b: UserProfile
): CompatibilityResult {
  const reasons: string[] = [];
  let score = 0;

  // ── Hard filters (dealbreakers eliminate the pair) ───────────────────────

  // Gender preference check (bidirectional)
  if (!genderPreferenceMatch(a, b) || !genderPreferenceMatch(b, a)) {
    return { score: 0, passed: false, reasons: ["Gender preference mismatch"], blockingFilter: "gender" };
  }

  // Age range check (bidirectional)
  if (!ageRangeMatch(a, b) || !ageRangeMatch(b, a)) {
    return { score: 0, passed: false, reasons: ["Age range mismatch"], blockingFilter: "age" };
  }

  // Location check
  if (!locationMatch(a, b)) {
    return { score: 0, passed: false, reasons: ["Location too far"], blockingFilter: "location" };
  }

  // Dealbreaker keyword check
  const dbResult = dealbreakersCheck(a, b);
  if (!dbResult.passed) {
    return { score: 0, passed: false, reasons: dbResult.reasons, blockingFilter: "dealbreaker" };
  }

  // ── Weighted scoring ─────────────────────────────────────────────────────

  const softGaps: string[] = [];

  // Relationship intent alignment (30 pts)
  const intentScore = relationshipIntentScore(a, b);
  score += intentScore * 30;
  if (intentScore > 0.8) reasons.push("Strong relationship intent alignment");
  if (intentScore < SOFT_GAP_THRESHOLD) softGaps.push("intent");

  // Shared interests (25 pts)
  const interestScore = sharedInterestScore(a, b);
  score += interestScore * 25;
  if (interestScore > 0.4) reasons.push(`${Math.round(interestScore * 100)}% interest overlap`);
  if (interestScore < SOFT_GAP_THRESHOLD) softGaps.push("interests");

  // Shared values (25 pts)
  const valueScore = sharedValueScore(a, b);
  score += valueScore * 25;
  if (valueScore > 0.4) reasons.push(`${Math.round(valueScore * 100)}% values alignment`);
  if (valueScore < SOFT_GAP_THRESHOLD) softGaps.push("values");

  // Personality complementarity (20 pts)
  const personalityScore = personalityComplementScore(a, b);
  score += personalityScore * 20;
  if (personalityScore > 0.6) reasons.push("Strong personality complementarity");
  if (personalityScore < SOFT_GAP_THRESHOLD) softGaps.push("personality");

  return {
    score: Math.round(score),
    passed: true,
    reasons,
    softGaps,
  };
}

// ─── Match pair deduplication ─────────────────────────────────────────────────

export interface MatchPair {
  userA: UserProfile;
  userB: UserProfile;
  score: number;
  reasons: string[];
}

/**
 * Deterministic re-match avoidance. A pair is blocked when EITHER side has a
 * BlockedMatch entry keyed by the other's phoneHash (declined or no_fit). Reads
 * only the structured blockedMatches list, never prose, so the matcher stays
 * deterministic. The matcher entry points (findTopMatches, attemptInstantMatch)
 * skip any blocked pair.
 */
export function isPairBlocked(a: UserProfile, b: UserProfile): boolean {
  const aBlocks = (a.blockedMatches ?? []).some((m) => m.phoneHash === b.phoneHash);
  const bBlocks = (b.blockedMatches ?? []).some((m) => m.phoneHash === a.phoneHash);
  return aBlocks || bBlocks;
}

// Nightly sweep gate. Dropped 50 -> 40 after the fuzzy-overlap recalibration:
// soft-scoring caps in the mid-40s, so 50 created zero pairs on the live pool.
export const NIGHTLY_MATCH_MIN_SCORE = 40;

export function findTopMatches(
  users: UserProfile[],
  minScore = NIGHTLY_MATCH_MIN_SCORE,
  maxMatchesPerUser = 1
): MatchPair[] {
  const pairs: MatchPair[] = [];
  const matchCount: Record<string, number> = {};

  // Compute all valid pairs
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const a = users[i];
      const b = users[j];

      // Skip same user (shouldn't happen, but guard anyway)
      if (a.phoneHash === b.phoneHash) continue;

      // Re-match avoidance: never re-pair a pair that already said no.
      if (isPairBlocked(a, b)) continue;

      const result = computeCompatibility(a, b);
      if (!result.passed || result.score < minScore) continue;

      pairs.push({
        userA: a,
        userB: b,
        score: result.score,
        reasons: result.reasons,
      });
    }
  }

  // Sort by score descending
  pairs.sort((a, b) => b.score - a.score);

  // Deduplicate: each user gets at most maxMatchesPerUser match proposals
  const selected: MatchPair[] = [];
  for (const pair of pairs) {
    const aCount = matchCount[pair.userA.phoneHash] ?? 0;
    const bCount = matchCount[pair.userB.phoneHash] ?? 0;

    if (aCount < maxMatchesPerUser && bCount < maxMatchesPerUser) {
      selected.push(pair);
      matchCount[pair.userA.phoneHash] = aCount + 1;
      matchCount[pair.userB.phoneHash] = bCount + 1;
    }
  }

  return selected;
}

// ─── Scoring functions ────────────────────────────────────────────────────────

/**
 * Normalize gender vocabulary to a canonical term. The model extracts gender
 * preference in mixed forms ("men"/"man"/"male", "women"/"woman"/"female",
 * "any"/"anyone") while demographics.gender is the singular enum. Without this,
 * a woman who wants "men" never matched a "man" (exact-string includes), which
 * blocked ~92% of pairs on gender and was the true cause of zero matches across
 * the early waves. Returns "man" | "woman" | "non-binary" | "any" | the raw
 * lowercased term, or null.
 */
export function normalizeGenderTerm(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;
  if (["man", "men", "male", "males", "guy", "guys", "m"].includes(s)) return "man";
  if (["woman", "women", "female", "females", "girl", "girls", "lady", "ladies", "f", "w"].includes(s)) return "woman";
  if (["non-binary", "nonbinary", "non binary", "enby", "nb"].includes(s)) return "non-binary";
  if (["any", "anyone", "all", "everyone", "either", "both", "whoever", "open", "no preference"].includes(s)) return "any";
  return s;
}

function genderPreferenceMatch(seeker: UserProfile, candidate: UserProfile): boolean {
  const prefs = (seeker.preferences.genderPreference ?? [])
    .map(normalizeGenderTerm)
    .filter((g): g is string => !!g);
  if (prefs.length === 0 || prefs.includes("any")) return true; // No/open preference = accepts all
  const candidateGender = normalizeGenderTerm(candidate.demographics.gender);
  if (!candidateGender) return true; // Unknown gender passes (err toward inclusivity)
  return prefs.includes(candidateGender);
}

function ageRangeMatch(seeker: UserProfile, candidate: UserProfile): boolean {
  const { ageMin, ageMax } = seeker.preferences;
  const candidateAge = candidate.demographics.age;
  if (!candidateAge) return true; // Unknown age passes
  if (ageMin && candidateAge < ageMin) return false;
  if (ageMax && candidateAge > ageMax) return false;
  return true;
}

// Canonical metros and their aliases (neighborhoods, suburbs, state-tagged
// forms). CONSERVATIVE: only well-known same-metro aliases are mapped; anything
// not listed passes through trimmed/lowercased and UNCHANGED. St. Louis and
// Kansas City are kept strictly distinct.
const ST_LOUIS_ALIASES = new Set([
  "st. louis", "st louis", "saint louis", "stl",
  "tower grove", "the grove", "the hill", "soulard", "central west end", "cwe",
  "clayton", "kirkwood", "webster groves", "maplewood", "richmond heights",
  "ballwin", "chesterfield", "creve coeur", "ladue", "brentwood", "shrewsbury",
  "affton", "florissant", "ferguson", "o'fallon mo", "st. charles", "st charles",
  "saint charles", "u city", "university city", "dogtown", "south city",
  "downtown st. louis", "downtown stl",
]);
const KANSAS_CITY_ALIASES = new Set([
  "kansas city", "kc", "kcmo", "kck",
  "overland park", "olathe", "lees summit", "lee's summit", "independence",
  "shawnee", "lenexa", "blue springs", "north kansas city", "liberty mo",
  "raytown", "gladstone", "leawood", "prairie village", "westport",
]);

/**
 * Deterministic city -> canonical metro. Steps:
 *  1. lowercase + trim
 *  2. strip a trailing state suffix (", mo" / ", missouri" / ", ks" / ", kansas"
 *     and bare " missouri"/" kansas")
 *  3. strip a leading neighborhood-prefix pattern "<hood>, <city>" -> keep the
 *     city part (e.g. "tower grove, st. louis" -> "st. louis")
 *  4. alias lookup -> "st. louis" | "kansas city"
 *  5. unknown -> return the cleaned (lowercased/trimmed) value unchanged
 * Never merges two genuinely-different metros. Exported for tests.
 */
export function normalizeCity(raw: unknown): string | null {
  if (raw == null) return null;
  let s = String(raw).toLowerCase().trim();
  if (!s) return null;

  // 2. strip state suffix
  s = s.replace(/,?\s*(missouri|kansas|mo|ks)\s*$/i, "").trim();
  s = s.replace(/[.,]+$/g, "").trim();

  // 3+4. check full string and each comma-part against alias sets
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const candidates = [s, ...parts];
  for (const c of candidates) {
    if (ST_LOUIS_ALIASES.has(c)) return "st. louis";
    if (KANSAS_CITY_ALIASES.has(c)) return "kansas city";
  }

  // 5. unknown: return the LAST comma-part (the city, not the neighborhood),
  // cleaned; or the whole cleaned string if no comma.
  const tail = parts.length > 0 ? parts[parts.length - 1] : s;
  // re-run state-strip on tail in case suffix sat on the tail part
  return tail.replace(/,?\s*(missouri|kansas|mo|ks)\s*$/i, "").trim() || s;
}

export function locationMatch(a: UserProfile, b: UserProfile): boolean {
  // Same metro is sufficient (MVP). Cross-metro passes only when at least one
  // side has been interpreted-open-to the other's metro (locationOpenCities),
  // keeping cross-region matching conservative and opt-in. The matcher never
  // parses the raw openness prose - only the structured locationOpenCities list.
  // Both sides are run through normalizeCity so free-text neighborhoods and
  // state-tagged forms collapse to their canonical metro at read time.
  const cityA = normalizeCity(a.demographics.city);
  const cityB = normalizeCity(b.demographics.city);
  if (!cityA || !cityB) return true; // Unknown city passes
  if (cityA === cityB) return true;

  const aOpenToB = (a.preferences.locationOpenCities ?? [])
    .map((c) => normalizeCity(c))
    .filter((c): c is string => !!c)
    .includes(cityB);
  const bOpenToA = (b.preferences.locationOpenCities ?? [])
    .map((c) => normalizeCity(c))
    .filter((c): c is string => !!c)
    .includes(cityA);
  return aOpenToB || bOpenToA;
}

function dealbreakersCheck(
  a: UserProfile,
  b: UserProfile
): { passed: boolean; reasons: string[] } {
  // Simple keyword matching on dealbreaker strings
  // Phase 2: semantic matching via embeddings
  const dbA = (a.preferences.dealbreakers ?? []).map((d) => d.toLowerCase());
  const dbB = (b.preferences.dealbreakers ?? []).map((d) => d.toLowerCase());

  for (const db of dbA) {
    if (matchesDealbreaker(db, b)) {
      return { passed: false, reasons: [`User A dealbreaker: ${db}`] };
    }
  }

  for (const db of dbB) {
    if (matchesDealbreaker(db, a)) {
      return { passed: false, reasons: [`User B dealbreaker: ${db}`] };
    }
  }

  return { passed: true, reasons: [] };
}

function matchesDealbreaker(dealbreaker: string, profile: UserProfile): boolean {
  // Check specific known dealbreaker patterns
  const db = dealbreaker.toLowerCase();

  if (db.includes("smoker") || db.includes("smoking")) {
    return (profile.personality.personalityTraits ?? []).some((t) =>
      t.toLowerCase().includes("smok")
    );
  }

  if (db.includes("no kids") || db.includes("doesn't want kids")) {
    // Dealbreaker = "I want someone who wants kids" → triggers if candidate doesn't want kids
    return profile.personality.wantsKids === false;
  }

  if (db.includes("wants kids") || db.includes("must want kids")) {
    // Dealbreaker = "I don't want kids" → triggers if candidate does want kids
    return profile.personality.wantsKids === true;
  }

  // Generic: check if dealbreaker keyword appears in personality traits
  const traits = [
    ...(profile.personality.personalityTraits ?? []),
    ...(profile.personality.interests ?? []),
    ...(profile.personality.values ?? []),
  ].join(" ").toLowerCase();

  return traits.includes(db);
}

function relationshipIntentScore(a: UserProfile, b: UserProfile): number {
  const intentA = a.preferences.relationshipIntent;
  const intentB = b.preferences.relationshipIntent;

  if (!intentA || !intentB) return 0.5; // Unknown = neutral

  if (intentA === intentB) return 1.0;
  if (intentA === "open" || intentB === "open") return 0.7;
  if (intentA === "unsure" || intentB === "unsure") return 0.5;

  // long-term vs casual = mismatch
  if (
    (intentA === "long-term" && intentB === "casual") ||
    (intentA === "casual" && intentB === "long-term")
  ) {
    return 0.1;
  }

  return 0.5;
}

// Tokens with no discriminating power. A pair sharing ONLY one of these must
// NOT count as overlapping (calibration guard against over-matching).
const TAG_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "my", "i", "im", "i'm", "love", "like", "enjoy", "really", "very", "lot",
  "lots", "some", "good", "great", "into", "being", "doing", "stuff", "things",
]);

/**
 * Normalize a free-text tag to meaningful tokens. Lowercases, strips
 * parentheticals ("hiking (Castlewood)" -> "hiking"), strips punctuation,
 * splits on whitespace, drops stopwords and tokens shorter than 3 chars.
 * Deterministic. Exported for unit tests.
 */
export function tagTokens(raw: unknown): string[] {
  if (raw == null) return [];
  let s = String(raw).toLowerCase();
  s = s.replace(/\([^)]*\)/g, " ");        // drop parentheticals
  s = s.replace(/[^a-z0-9\s]/g, " ");      // drop punctuation
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !TAG_STOPWORDS.has(t));
}

/**
 * Two tags overlap when, after normalization, they share at least one
 * meaningful token (length >= 3, non-stopword). Token-level containment is
 * covered by the shared-token rule ("live music" and "music" share "music";
 * "hiking" and "hiking (Castlewood)" share "hiking"). A single trivial shared
 * token can never trigger a match because stopwords and <3-char tokens are
 * already dropped in tagTokens. Deterministic.
 */
function tagsOverlap(tokensA: string[], tokensB: string[]): boolean {
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setB = new Set(tokensB);
  return tokensA.some((t) => setB.has(t));
}

/**
 * Deterministic fuzzy overlap in [0,1]. Two tag LISTS are compared by counting,
 * for each side, how many of its tags have at least one fuzzy-overlapping tag on
 * the other side; the score is the symmetric ratio
 *   (matchedA + matchedB) / (lenA + lenB).
 * This is a token-aware generalization of Jaccard: identical sets -> 1.0,
 * disjoint sets -> 0.0, and near-synonyms ("hiking" ~ "hiking (Castlewood)")
 * count as hits. Calibrated against over-matching: trivial/short/stopword tokens
 * are stripped before comparison, so unrelated tags score 0.
 */
export function fuzzyOverlapScore(rawA: string[], rawB: string[]): number {
  const a = (rawA ?? []).map(tagTokens).filter((t) => t.length > 0);
  const b = (rawB ?? []).map(tagTokens).filter((t) => t.length > 0);
  if (a.length === 0 || b.length === 0) return 0;
  let matchedA = 0;
  for (const ta of a) if (b.some((tb) => tagsOverlap(ta, tb))) matchedA++;
  let matchedB = 0;
  for (const tb of b) if (a.some((ta) => tagsOverlap(ta, tb))) matchedB++;
  return (matchedA + matchedB) / (a.length + b.length);
}

function sharedInterestScore(a: UserProfile, b: UserProfile): number {
  return fuzzyOverlapScore(a.personality.interests ?? [], b.personality.interests ?? []);
}

function sharedValueScore(a: UserProfile, b: UserProfile): number {
  return fuzzyOverlapScore(a.personality.values ?? [], b.personality.values ?? []);
}

function personalityComplementScore(a: UserProfile, b: UserProfile): number {
  // Simple complementarity heuristic
  // Phase 2: train a proper complementarity model on feedback data
  let score = 0.5; // default neutral

  // Same humor style = +0.2
  if (
    a.personality.humorStyle &&
    b.personality.humorStyle &&
    a.personality.humorStyle === b.personality.humorStyle
  ) {
    score += 0.2;
  }

  // Complementary communication: texter + texter is great, caller + caller is great
  if (
    a.personality.communicationStyle &&
    b.personality.communicationStyle &&
    a.personality.communicationStyle === b.personality.communicationStyle
  ) {
    score += 0.15;
  }

  // One introvert + one extrovert can work — reward the mix
  const traits = [
    ...(a.personality.personalityTraits ?? []).map((t) => t.toLowerCase()),
    ...(b.personality.personalityTraits ?? []).map((t) => t.toLowerCase()),
  ];
  const hasIntrovert = traits.some((t) => t.includes("introvert"));
  const hasExtrovert = traits.some((t) => t.includes("extrovert"));
  if (hasIntrovert && hasExtrovert) score += 0.1;

  return Math.min(score, 1.0);
}
