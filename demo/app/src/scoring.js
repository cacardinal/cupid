// Client-side port of functions/src/scheduler/matchingJob.ts computeCompatibility,
// extended to expose the per-dimension breakdown for the dashboard's score bars.
// Keep in sync with the backend — the backend remains the source of truth.

function jaccard(aArr, bArr) {
  const A = new Set((aArr ?? []).map((s) => s.toLowerCase()));
  const B = new Set((bArr ?? []).map((s) => s.toLowerCase()));
  if (A.size === 0 && B.size === 0) return 0;
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return inter / union;
}

function genderOk(seeker, candidate) {
  const prefs = seeker.preferences?.genderPreference;
  if (!prefs || prefs.length === 0) return true;
  const g = candidate.demographics?.gender;
  if (!g) return true;
  return prefs.includes(g);
}

function ageOk(seeker, candidate) {
  const { ageMin, ageMax } = seeker.preferences ?? {};
  const age = candidate.demographics?.age;
  if (!age) return true;
  if (ageMin && age < ageMin) return false;
  if (ageMax && age > ageMax) return false;
  return true;
}

function cityOk(a, b) {
  const ca = a.demographics?.city?.toLowerCase().trim();
  const cb = b.demographics?.city?.toLowerCase().trim();
  if (!ca || !cb) return true;
  return ca === cb;
}

function matchesDealbreaker(db, profile) {
  const d = db.toLowerCase();
  const p = profile.personality ?? {};
  if (d.includes("smoker") || d.includes("smoking")) {
    return (p.personalityTraits ?? []).some((t) => t.toLowerCase().includes("smok"));
  }
  if (d.includes("no kids") || d.includes("doesn't want kids")) return p.wantsKids === false;
  if (d.includes("wants kids") || d.includes("must want kids")) return p.wantsKids === true;
  const traits = [...(p.personalityTraits ?? []), ...(p.interests ?? []), ...(p.values ?? [])]
    .join(" ")
    .toLowerCase();
  return traits.includes(d);
}

function intentScore(a, b) {
  const ia = a.preferences?.relationshipIntent;
  const ib = b.preferences?.relationshipIntent;
  if (!ia || !ib) return 0.5;
  if (ia === ib) return 1.0;
  if (ia === "open" || ib === "open") return 0.7;
  if (ia === "unsure" || ib === "unsure") return 0.5;
  if ((ia === "long-term" && ib === "casual") || (ia === "casual" && ib === "long-term")) return 0.1;
  return 0.5;
}

function personalityScore(a, b) {
  let s = 0.5;
  const pa = a.personality ?? {};
  const pb = b.personality ?? {};
  if (pa.humorStyle && pb.humorStyle && pa.humorStyle === pb.humorStyle) s += 0.2;
  if (pa.communicationStyle && pb.communicationStyle && pa.communicationStyle === pb.communicationStyle)
    s += 0.15;
  const traits = [...(pa.personalityTraits ?? []), ...(pb.personalityTraits ?? [])].map((t) =>
    t.toLowerCase()
  );
  if (traits.some((t) => t.includes("introvert")) && traits.some((t) => t.includes("extrovert")))
    s += 0.1;
  return Math.min(s, 1.0);
}

export function computeCompatibility(a, b) {
  if (!genderOk(a, b) || !genderOk(b, a))
    return { score: 0, passed: false, reasons: ["Gender preference mismatch"], breakdown: null };
  if (!ageOk(a, b) || !ageOk(b, a))
    return { score: 0, passed: false, reasons: ["Age range mismatch"], breakdown: null };
  if (!cityOk(a, b))
    return { score: 0, passed: false, reasons: ["Location too far"], breakdown: null };

  for (const db of a.preferences?.dealbreakers ?? []) {
    if (matchesDealbreaker(db, b))
      return { score: 0, passed: false, reasons: [`Dealbreaker: ${db}`], breakdown: null };
  }
  for (const db of b.preferences?.dealbreakers ?? []) {
    if (matchesDealbreaker(db, a))
      return { score: 0, passed: false, reasons: [`Dealbreaker: ${db}`], breakdown: null };
  }

  const breakdown = {
    intent: { raw: intentScore(a, b), weight: 30 },
    interests: { raw: jaccard(a.personality?.interests, b.personality?.interests), weight: 25 },
    values: { raw: jaccard(a.personality?.values, b.personality?.values), weight: 25 },
    personality: { raw: personalityScore(a, b), weight: 20 },
  };

  let score = 0;
  const reasons = [];
  for (const [key, { raw, weight }] of Object.entries(breakdown)) {
    breakdown[key].points = raw * weight;
    score += raw * weight;
  }
  if (breakdown.intent.raw > 0.8) reasons.push("Strong relationship intent alignment");
  if (breakdown.interests.raw > 0.4)
    reasons.push(`${Math.round(breakdown.interests.raw * 100)}% interest overlap`);
  if (breakdown.values.raw > 0.4)
    reasons.push(`${Math.round(breakdown.values.raw * 100)}% values alignment`);
  if (breakdown.personality.raw > 0.6) reasons.push("Strong personality complementarity");

  return { score: Math.round(score), passed: true, reasons, breakdown };
}

/** All unique pairs among users, scored, sorted descending (blocked pairs last). */
export function scoreAllPairs(users) {
  const pairs = [];
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      pairs.push({ a: users[i], b: users[j], ...computeCompatibility(users[i], users[j]) });
    }
  }
  pairs.sort((x, y) => (y.passed - x.passed) || (y.score - x.score));
  return pairs;
}
