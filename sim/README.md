# Cupid Simulation Harness

Mock launches: synthetic St. Louis users (census-weighted personas) chat with the real Cupid engine on the local emulators. Both sides served by `claude -p` (your Claude Code subscription/Agent SDK credit), zero Anthropic API spend.

## Run a wave (4 commands)
```bash
node sim/bridge.mjs &                                   # claude -p HTTP bridge :5599
npx -y firebase-tools emulators:start --only functions,firestore,pubsub --project cupid-dating-mvp &
node sim/personas/generate.mjs --count 100 --seed 42    # census-weighted, haiku-flavored
node sim/engine.mjs --users 100 --vdays 7 --wallhours 2 --seed 42 --wave 1
node sim/analyze.mjs --wave 1 --personas sim/personas/personas-100.jsonl
```
Requires `CLAUDE_BRIDGE_URL=http://127.0.0.1:5599` + `DEMO_MODE=true` in functions/.env.local.

Scale guide: fold wave = 100 users / 7 vdays (~1-2h). Soak = 1000 / 14 vdays overnight (use --wallhours 8). Engine checkpoints to sim/state/, usage logs to sim/state/usage.jsonl.

Reports land in sim/reports/wave-N.md: funnel, extraction accuracy vs persona ground truth, match-quality oracle, voice audit + judge scores. Watch live in the demo harness (demo/app, :5180).
