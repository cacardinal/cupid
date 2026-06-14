import { UserProfile } from "../models/user";
import { BlockingFilter, computeCompatibility } from "../scheduler/matchingJob";

// ─── Near-match targeting ─────────────────────────────────────────────────────
//
// A near-match is a candidate that would PASS computeCompatibility and clear a
// soft threshold EXCEPT for exactly ONE resolvable blocker:
//   - location they may flex on (openness),
//   - age just outside their stated range (age_slack), or
//   - an UNKNOWN field on the MEMBER that, once filled, would decide the pair.
// Two or more blockers => not a near-match. A hard gender mismatch (both sides
// known and incompatible) is never resolvable, so never a near-match.
//
// Pure and deterministic. No I/O. The natural-language phrasing happens in the
// generator prompt; here we return a plain canonical question string.

export const NEAR_MATCH_SOFT_MIN = 55; // soft-dim score bar to be "promising"
export const NEAR_MATCH_AGE_SLACK = 2; // years outside range still considered near
export const NEAR_MATCH_REVEAL_MIN = 65; // reveal candidates need a higher bar

export interface NearMatch {
  candidate: UserProfile;
  softScore: number; // weighted score on KNOWN soft dims (0-100), for ranking
  blockingFilter: BlockingFilter; // the single thing in the way
  resolvable: "openness" | "age_slack" | "unknown_field"; // how it could clear
  question: string; // the single decisive question to ask the MEMBER
  topic: string; // stable key for de-dup, e.g. "openness:kansas city" | "gap:values"
  revealCity?: string; // candidate's city when blockingFilter === "location"
}

function lc(s?: string): string | undefined {
  return s?.toLowerCase().trim();
}

function genderOk(seeker: UserProfile, candidate: UserProfile): boolean {
  const prefs = seeker.preferences.genderPreference;
  if (!prefs || prefs.length === 0) return true;
  const g = candidate.demographics.gender;
  if (!g) return true;
  return prefs.includes(g);
}

// True when a hard gender mismatch is KNOWN on either side (both gender + pref
// present and incompatible). Never resolvable.
function hardGenderMismatch(a: UserProfile, b: UserProfile): boolean {
  const aPref = a.preferences.genderPreference;
  const bPref = b.preferences.genderPreference;
  const aBlocksB = !!aPref && aPref.length > 0 && !!b.demographics.gender && !genderOk(a, b);
  const bBlocksA = !!bPref && bPref.length > 0 && !!a.demographics.gender && !genderOk(b, a);
  return aBlocksB || bBlocksA;
}

// Does an unknown gender / gender-preference on the MEMBER currently block the
// pair? (member has no gender preference set, OR candidate gender unknown but
// member has a preference). Resolvable by asking the member.
function genderUnknownOnMember(member: UserProfile, candidate: UserProfile): boolean {
  const pref = member.preferences.genderPreference;
  if (!pref || pref.length === 0) return true; // member never told us who they want
  if (!candidate.demographics.gender) return true; // can't decide without it
  return false;
}

// Age blocker: candidate falls outside the member's stated range. Returns
// "slack" if within NEAR_MATCH_AGE_SLACK of a boundary, "hard" if further,
// null if no age blocker (or unknown age).
function ageBlocker(member: UserProfile, candidate: UserProfile): "slack" | "hard" | null {
  const { ageMin, ageMax } = member.preferences;
  const age = candidate.demographics.age;
  if (!age) return null;
  if (ageMin && age < ageMin) {
    return ageMin - age <= NEAR_MATCH_AGE_SLACK ? "slack" : "hard";
  }
  if (ageMax && age > ageMax) {
    return age - ageMax <= NEAR_MATCH_AGE_SLACK ? "slack" : "hard";
  }
  return null;
}

// Location blocker: different city and neither side opened to the other. The
// member can flex (openness) so it is resolvable.
function locationBlocked(member: UserProfile, candidate: UserProfile): boolean {
  const cityA = lc(member.demographics.city);
  const cityB = lc(candidate.demographics.city);
  if (!cityA || !cityB) return false; // unknown city does not block
  if (cityA === cityB) return false;
  const aOpen = (member.preferences.locationOpenCities ?? []).map((c) => c.toLowerCase().trim());
  const bOpen = (candidate.preferences.locationOpenCities ?? []).map((c) => c.toLowerCase().trim());
  return !aOpen.includes(cityB) && !bOpen.includes(cityA);
}

// Soft score on the dims we can already evaluate. We reuse computeCompatibility
// by neutralizing the single blocker (cloning the member so the pair PASSES),
// then read the resulting weighted score. Keeps weights identical to matching.
function softScoreWithBlockerRemoved(
  member: UserProfile,
  candidate: UserProfile,
  blocker: BlockingFilter
): number {
  const m: UserProfile = {
    ...member,
    demographics: { ...member.demographics },
    preferences: { ...member.preferences },
  };
  if (blocker === "location") {
    const cityB = lc(candidate.demographics.city);
    m.preferences.locationOpenCities = [
      ...(member.preferences.locationOpenCities ?? []),
      cityB ?? "",
    ];
  } else if (blocker === "age") {
    // widen the member's range to include the candidate
    const age = candidate.demographics.age;
    if (age) {
      m.preferences.ageMin = Math.min(member.preferences.ageMin ?? age, age);
      m.preferences.ageMax = Math.max(member.preferences.ageMax ?? age, age);
    }
  } else if (blocker === "gender") {
    // clear the member's gender preference so the unknown resolves to "open"
    m.preferences.genderPreference = [];
  }
  const r = computeCompatibility(m, candidate);
  return r.passed ? r.score : 0;
}

/**
 * Find candidates blocked by exactly one resolvable thing, ranked by softScore.
 */
export function findNearMatches(
  member: UserProfile,
  pool: UserProfile[],
  limit = 3
): NearMatch[] {
  const results: NearMatch[] = [];

  for (const candidate of pool) {
    if (candidate.phoneHash === member.phoneHash) continue;

    // Hard gender mismatch is never resolvable.
    if (hardGenderMismatch(member, candidate)) continue;

    const passes = computeCompatibility(member, candidate).passed;
    const unknownField = genderUnknownOnMember(member, candidate);

    // A real match that does NOT lean on an unknown member field is already a
    // match, not a near-match.
    if (passes && !unknownField) continue;

    // Enumerate the resolvable blockers in play.
    const blockers: Array<{
      filter: BlockingFilter;
      resolvable: NearMatch["resolvable"];
    }> = [];

    if (locationBlocked(member, candidate)) {
      blockers.push({ filter: "location", resolvable: "openness" });
    }

    const age = ageBlocker(member, candidate);
    if (age === "slack") {
      blockers.push({ filter: "age", resolvable: "age_slack" });
    } else if (age === "hard") {
      // a hard age gap is an unresolvable blocker; count it so two-blocker
      // candidates are excluded, but don't offer it as resolvable.
      blockers.push({ filter: "age", resolvable: "age_slack" as never });
    }

    if (unknownField) {
      blockers.push({ filter: "gender", resolvable: "unknown_field" });
    }

    // Exactly one blocker, and it must be resolvable.
    if (blockers.length !== 1) continue;
    const sole = blockers[0];
    if (sole.filter === "age" && age === "hard") continue; // single but unresolvable

    const softScore = softScoreWithBlockerRemoved(member, candidate, sole.filter);
    if (softScore < NEAR_MATCH_SOFT_MIN) continue;

    const { question, topic, revealCity } = describeBlocker(member, candidate, sole.filter, sole.resolvable);

    results.push({
      candidate,
      softScore,
      blockingFilter: sole.filter,
      resolvable: sole.resolvable,
      question,
      topic,
      revealCity,
    });
  }

  results.sort((a, b) => b.softScore - a.softScore);
  return results.slice(0, limit);
}

function describeBlocker(
  member: UserProfile,
  candidate: UserProfile,
  filter: BlockingFilter,
  resolvable: NearMatch["resolvable"]
): { question: string; topic: string; revealCity?: string } {
  if (filter === "location") {
    const city = candidate.demographics.city ?? "another city";
    return {
      question: `Would you be open to meeting someone in ${city}?`,
      topic: `openness:${city.toLowerCase().trim()}`,
      revealCity: city,
    };
  }
  if (filter === "age") {
    return {
      question: `How firm is your age range, would a year or two outside it be okay?`,
      topic: `age_slack`,
    };
  }
  // gender / unknown_field
  if (!member.preferences.genderPreference || member.preferences.genderPreference.length === 0) {
    return {
      question: `Who are you hoping to meet, men, women, or open to anyone?`,
      topic: `gap:genderPreference`,
    };
  }
  return {
    question: `Anything that's an absolute dealbreaker for you?`,
    topic: `gap:dealbreakers`,
  };
}

/**
 * A near-match qualifies for a transparent reveal only when the soft score is
 * high and the single blocker is location (a region the member can flex on).
 */
export function isRevealCandidate(nm: NearMatch): boolean {
  return nm.blockingFilter === "location" && nm.softScore >= NEAR_MATCH_REVEAL_MIN;
}
