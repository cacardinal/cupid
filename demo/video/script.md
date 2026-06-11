# Cupid demo video — shot script (~90s)

Recorded automatically: `bash demo/video/build.sh` (emulators + seeded data + harness running).
Narration = macOS `say` fallback (Deepgram Aura if a real DEEPGRAM_API_KEY is in functions/.env.local).
Each scene is a separate Playwright clip, time-fitted to its narration, then concatenated.

| # | Screen | Narration |
|---|--------|-----------|
| 1 | Phones tab, two seeded conversations | This is Cupid — an A.I. matchmaker you text. No app, no profiles, no swiping. Everything you're about to see is the real system: live Claude conversations, a real matching engine, and a real database, running end to end. |
| 2 | Maya sends a message, Claude replies live | Users just talk. Claude learns them — and quietly extracts a structured profile from every message. Age, values, interests, dealbreakers. This reply is being generated live, right now. |
| 3 | Matchmaker dashboard, user grid | Twelve synthetic users, engineered to stress the engine — compatible pairs, borderline cases, and built-in conflicts. |
| 4 | Run Nightly Matching, results animate in | Hard filters run first — mutual gender preference, age ranges, location, dealbreakers. Then weighted compatibility: relationship intent, shared interests, shared values, personality fit. Maya and Eli score ninety-three. And look at Tessa and Rob — near-perfect on paper, but he smokes and that's her hard no. Blocked, no matter the score. |
| 5 | Both phones reply yes, video link arrives | When both sides say yes, Cupid sends an anonymous video link. Fifteen minutes, first names only, nobody's number changes hands. |
| 6 | Mock video room, countdown running | They meet face to face before they share anything else. |
| 7 | Sam's paywall, fake checkout completes | The first introduction is free. After that, you pay per introduction — not per month of swiping. Built on Claude, Twilio, Firebase, and Daily. |
