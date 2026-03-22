# Cupid — AI-First Conversational Matchmaker

> No swiping. No profiles. Just a conversation with an AI that gets smarter about you over time.

## Overview

Cupid is an SMS/voice-native matchmaking service. Users text a dedicated phone number and interact with an AI (powered by Claude) that learns their preferences through natural dialogue, builds rich personality profiles, and facilitates anonymous introductions — including anonymous video calls before any personal info changes hands.

**Tech stack:**
- **Messaging:** Twilio SMS webhooks
- **AI:** Anthropic Claude API (`claude-sonnet-4-5`)
- **Backend:** Firebase Cloud Functions (TypeScript)
- **Database:** Firestore
- **Video:** Daily.co anonymous rooms
- **Hosting:** GCP / Firebase

## Project Structure

```
cupid/
├── functions/
│   ├── src/
│   │   ├── index.ts                  # Cloud Function exports
│   │   ├── models/
│   │   │   └── user.ts               # UserProfile, MatchRecord, types
│   │   ├── services/
│   │   │   ├── claude.ts             # Claude API + profile extraction
│   │   │   ├── firestore.ts          # Firestore CRUD + phone hashing
│   │   │   ├── twilio.ts             # SMS sending
│   │   │   └── daily.ts             # Daily.co video rooms
│   │   ├── prompts/
│   │   │   └── cupid.ts              # System prompts + profile building
│   │   ├── webhooks/
│   │   │   └── sms.ts                # Inbound SMS handler
│   │   └── scheduler/
│   │       └── matchingJob.ts        # Compatibility scoring + matching
│   └── src/__tests__/               # Jest tests
├── firebase.json
├── firestore.rules                   # Admin-only access (no client reads)
└── firestore.indexes.json
```

## Setup

### 1. Prerequisites

```bash
npm install -g firebase-tools
firebase login
firebase use --add  # Select or create a GCP project
```

### 2. Install dependencies

```bash
cd functions && npm install
```

### 3. Configure environment variables

```bash
# Copy and fill in your keys
cp .env.example .env

# Set Firebase function config (for deployed functions)
firebase functions:config:set \
  anthropic.api_key="sk-ant-..." \
  twilio.account_sid="AC..." \
  twilio.auth_token="..." \
  twilio.phone_number="+1..." \
  daily.api_key="..."
```

### 4. Configure Twilio webhook

In your Twilio console, set the SMS webhook URL for your Cupid phone number to:
```
https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/smsWebhook
```

### 5. Run locally

```bash
cd functions
npm run build
firebase emulators:start
```

## Testing

```bash
cd functions
npm test                # Run all tests
npm run test:coverage   # Run with coverage report
```

Tests cover:
- `matching.test.ts` — Compatibility scoring, dealbreaker filters, match deduplication
- `claude.test.ts` — Profile update merging logic
- `firestore.test.ts` — Phone normalization and hashing
- `prompts.test.ts` — System prompt generation, profile descriptions

## Deploy

```bash
firebase deploy --only functions
firebase deploy --only firestore
```

## User Journey (MVP)

1. **User texts the Cupid number** → Twilio webhook triggers `smsWebhook`
2. **Onboarding conversation** → Claude gathers profile data through 5 stages (greeting → basics → looking_for → personality → dealbreakers → complete)
3. **Nightly matching** → `nightlyMatching` job runs at 2am CT, scores all active users, generates top pairs
4. **Match proposal** → Cupid texts both users with a personality-based description, asks if interested
5. **Mutual interest** → Both say yes → Daily.co anonymous video room created, links sent simultaneously
6. **Post-call follow-up** → `videoExpiryFollowUp` job detects expired rooms, Cupid asks how it went
7. **Contact exchange** → Both consent → names and phone numbers shared

## Privacy

- Phone numbers are SHA-256 hashed and never stored in plaintext
- Firestore rules block all client-side access (admin SDK only)
- Video rooms are anonymous, time-limited, and auto-deleted
- Users can request data deletion at any time

## Roadmap

See [PRD](docs/PRD.md) for full roadmap including:
- Phase 2: Graph RAG profile engine (Neo4j), real-time matching, message relay mode
- Phase 3: City expansion tooling, feedback-driven match learning
