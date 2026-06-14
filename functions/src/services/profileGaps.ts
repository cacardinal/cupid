import { UserProfile } from "../models/user";

// ─── Profile gaps (match-impact ordered) ──────────────────────────────────────
//
// Rank the thin/missing fields that matter most to compatibility, using the SAME
// priority as the weighted dims in computeCompatibility (no drift): the hard
// filters (age range, gender preference) gate everything, so missing basics rank
// first; then relationship intent (30 pts), then dealbreakers (a hard filter),
// then thin values/interests (25 pts each), then wantsKids. Pure, deterministic.

export interface ProfileGap {
  field: string; // e.g. "values" | "dealbreakers" | "wantsKids" | "ageRange"
  question: string; // canonical question to fill it
  topic: string; // "gap:values" etc., for de-dup
}

const THIN_LIST_MIN = 2; // fewer than this many entries counts as thin

export function profileGaps(member: UserProfile): ProfileGap[] {
  const gaps: ProfileGap[] = [];
  const { preferences: p, personality: per } = member;

  // 1. Missing basics. The hard filters gate every match.
  if (!p.ageMin && !p.ageMax) {
    gaps.push({
      field: "ageRange",
      question: "What age range are you hoping for?",
      topic: "gap:ageRange",
    });
  }
  if (!p.genderPreference || p.genderPreference.length === 0) {
    gaps.push({
      field: "genderPreference",
      question: "Who are you hoping to meet, men, women, or open to anyone?",
      topic: "gap:genderPreference",
    });
  }

  // 2. Relationship intent (30 pts).
  if (!p.relationshipIntent) {
    gaps.push({
      field: "relationshipIntent",
      question: "Are you after something serious, something casual, or still figuring it out?",
      topic: "gap:relationshipIntent",
    });
  }

  // 3. Dealbreakers (hard filter).
  if (!p.dealbreakers || p.dealbreakers.length === 0) {
    gaps.push({
      field: "dealbreakers",
      question: "Anything that's an absolute dealbreaker for you?",
      topic: "gap:dealbreakers",
    });
  }

  // 4. Thin values / interests (25 pts each).
  if ((per.values?.length ?? 0) < THIN_LIST_MIN) {
    gaps.push({
      field: "values",
      question: "What matters most to you in how you live, the stuff you won't compromise on?",
      topic: "gap:values",
    });
  }
  if ((per.interests?.length ?? 0) < THIN_LIST_MIN) {
    gaps.push({
      field: "interests",
      question: "What do you actually love spending your time on?",
      topic: "gap:interests",
    });
  }

  // 5. wantsKids (feeds dealbreaker evaluation).
  if (per.wantsKids === undefined) {
    gaps.push({
      field: "wantsKids",
      question: "Where do you land on kids someday?",
      topic: "gap:wantsKids",
    });
  }

  return gaps;
}
