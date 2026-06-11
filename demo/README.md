# Cupid Demo Harness

Visual test harness for the SMS-native matchmaker. Simulates phones, drives the
real backend (live Claude, real Firestore writes, real matching engine) against
local emulators — no Twilio, no Daily.co, no production anything.

## Run it (3 commands)

```bash
# 1. Emulators (functions/.env.local needs ANTHROPIC_API_KEY + DEMO_MODE=true)
cd functions && npm run build && cd .. && npx -y firebase-tools emulators:start --only functions,firestore,pubsub --project cupid-dating-mvp

# 2. Seed 12 synthetic users (new terminal)
node demo/seed.mjs --reset

# 3. Harness UI
cd demo/app && npm install && npm run dev   # → http://localhost:5180
```

## What DEMO_MODE changes (functions/.env.local, never set in prod)

| Surface | Production | Demo mode |
|---|---|---|
| Outbound SMS | Twilio API | `demo_outbox` Firestore collection (rendered as bubbles) |
| Video rooms | Daily.co API | `http://localhost:5180/video/:matchId` mock room |
| Scheduled jobs | PubSub cron | `demoAdmin` HTTP endpoint (`?action=runMatching` / `?action=expireVideo`) |

## Demo script

1. **Phones tab** — pick Maya + Eli (pre-seeded, fully onboarded). Or pick
   "New user" and onboard from scratch with live Claude.
2. **Matchmaker tab** — Run Nightly Matching. Watch Eli+Maya match at 93 with
   the score breakdown; Tessa+Rob blocked by her smoking dealbreaker;
   Diane+Walt blocked on age.
3. Back to **Phones** — both reply "yes" to the proposal → anonymous video
   link appears → open it (mock room with countdown).
4. Matchmaker → click the matched pair → **Force video expiry** → both phones
   get the post-call follow-up → both reply "yes" → contacts exchanged.
5. Switch a phone to **Sam (0 credits)** — tap the credits pill → demo paywall
   (PRD pricing, fake checkout, credits update live).

## Synthetic users

12 personas in `personas.json`, engineered against `computeCompatibility()`:
- Maya+Eli ≈93 and Priya+Marcus ≈73 (high pairs)
- Jordan+Sam ≈56 (borderline, just above the 50 threshold)
- Tessa+Rob — would be ~95 but blocked by smoking dealbreaker
- Diane+Walt — blocked by bidirectional age-range filter
- Chloe+Andre ≈15 — casual vs long-term intent mismatch
- Sam & Chloe have 0 credits (paywall demo)

Names/phones exist ONLY in the harness — the backend stays anonymous
(SHA-256 hashed phones, AES-256-GCM encrypted reverse mapping).
