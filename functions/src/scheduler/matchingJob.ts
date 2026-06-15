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

export function findTopMatches(
  users: UserProfile[],
  minScore = 50,
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

export function locationMatch(a: UserProfile, b: UserProfile): boolean {
  // Same city is sufficient (MVP). Cross-city passes only when at least one side
  // has been interpreted-open-to the other's city (locationOpenCities), keeping
  // cross-region matching conservative and opt-in. The matcher never parses the
  // raw openness prose — only the structured locationOpenCities list.
  const cityA = a.demographics.city?.toLowerCase().trim();
  const cityB = b.demographics.city?.toLowerCase().trim();
  if (!cityA || !cityB) return true; // Unknown city passes
  if (cityA === cityB) return true;

  const aOpenToB = (a.preferences.locationOpenCities ?? [])
    .map((c) => c.toLowerCase().trim())
    .includes(cityB);
  const bOpenToA = (b.preferences.locationOpenCities ?? [])
    .map((c) => c.toLowerCase().trim())
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

function sharedInterestScore(a: UserProfile, b: UserProfile): number {
  return jaccardSimilarity(
    new Set((a.personality.interests ?? []).map((s) => s.toLowerCase())),
    new Set((b.personality.interests ?? []).map((s) => s.toLowerCase()))
  );
}

function sharedValueScore(a: UserProfile, b: UserProfile): number {
  return jaccardSimilarity(
    new Set((a.personality.values ?? []).map((s) => s.toLowerCase())),
    new Set((b.personality.values ?? []).map((s) => s.toLowerCase()))
  );
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

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}
