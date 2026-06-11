import { Timestamp } from "firebase-admin/firestore";

export type Gender = "man" | "woman" | "non-binary" | "other" | "prefer_not_to_say";
export type Orientation = "straight" | "gay" | "lesbian" | "bisexual" | "other";
export type RelationshipIntent = "long-term" | "casual" | "open" | "unsure";
export type HumorStyle = "dry" | "sarcastic" | "silly" | "witty" | "deadpan" | "none";
export type CommunicationStyle = "texter" | "caller" | "in-person" | "mixed";

// Live mode — user is actively available for an instant connection right now
export type LiveStatus = "offline" | "waiting" | "connecting" | "in_call";

export interface Demographics {
  age?: number;
  gender?: Gender;
  city?: string;
  orientation?: Orientation;
}

export interface Preferences {
  ageMin?: number;
  ageMax?: number;
  radiusMiles?: number;
  genderPreference?: Gender[];
  relationshipIntent?: RelationshipIntent;
  dealbreakers?: string[];
}

export interface Personality {
  humorStyle?: HumorStyle;
  communicationStyle?: CommunicationStyle;
  values?: string[];
  interests?: string[];
  personalityTraits?: string[];
  livingSituation?: string;
  hasKids?: boolean;
  wantsKids?: boolean;
  education?: string;
  occupation?: string;
}

export interface UserProfile {
  phoneHash: string;           // SHA-256 of E.164 phone number
  createdAt: Timestamp;
  updatedAt: Timestamp;
  onboardingComplete: boolean;
  onboardingStage: OnboardingStage;
  demographics: Demographics;
  preferences: Preferences;
  personality: Personality;
  active: boolean;
  matchCooldownUntil?: Timestamp;
  lastCheckinAt?: Timestamp;   // friend-mode: last proactive check-in
  checkinCount?: number;       // friend-mode: total check-ins sent
  quietHoursStart?: number;    // 0-23, hour in user's timezone
  quietHoursEnd?: number;
  totalMatches: number;
  creditsRemaining: number;    // Intro credits purchased
  testUser: boolean;           // Seed users for beta

  // Live mode fields
  liveStatus: LiveStatus;
  liveStatusUntil?: Timestamp; // When "waiting" expires (default: +30 min)
  liveSessionId?: string;      // Tracks the current live session to prevent double-connects

  // Narrative memory layer (internal context, never sent to the user directly)
  narrative?: string;          // Running 2-4 sentence third-person life summary
  narrativeUpdatedAt?: Timestamp;
  narrativeTurnCount?: number; // Total conversation turns seen at last narrative update

  // Daily conversation budget (usageGuard.ts, freeloader cost control)
  dailyTurnDate?: string;      // CT date string YYYY-MM-DD
  dailyTurnCount?: number;
  capNoticeDate?: string;      // CT date the over-cap notice was sent

  // Referral fields
  referralCode: string;        // "CUP-" + first 6 chars of phoneHash (uppercase)
  referredBy?: string;         // referralCode of the person who referred this user
  referralCount: number;       // How many users this person has successfully referred
}

export type OnboardingStage =
  | "greeting"
  | "basics"
  | "looking_for"
  | "personality"
  | "dealbreakers"
  | "complete";

export interface ConversationTurn {
  id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Timestamp;
  profileUpdates?: Partial<Omit<UserProfile, "phoneHash" | "createdAt">>;
}

export interface MatchRecord {
  id?: string;
  userId: string;              // phoneHash of this user
  matchedUserId: string;       // phoneHash of the other user
  status: MatchStatus;
  compatibilityScore: number;
  proposedAt: Timestamp;
  updatedAt: Timestamp;
  userAccepted?: boolean;
  matchAccepted?: boolean;
  videoRoomUrl?: string;
  videoRoomExpiry?: Timestamp;
  videoCallCompleted?: boolean;
  contactExchanged?: boolean;
  feedbackGiven?: boolean;
  feedbackScore?: number;      // 1-5 post-call rating
  feedbackNotes?: string;
  // Scheduled-date flow
  proposedSlots?: Timestamp[];   // candidate times Cupid offered
  scheduledAt?: Timestamp;       // locked-in date time
  slotPickedBy?: string;         // phoneHash of the user who picked first
  reminderSent?: boolean;        // T-15min reminder delivered
}

export type MatchStatus =
  // Async flow (nightly batch)
  | "proposed"         // Cupid reached out, awaiting user response
  | "user_accepted"    // This user said yes, waiting for other
  | "user_declined"    // This user said no
  // Scheduled-date flow (mutual interest -> coordinated time)
  | "scheduling"       // Both accepted; Cupid proposing time slots
  | "scheduled"        // Date time locked in; room opens at scheduledAt
  // Live flow (instant connect)
  | "live_connecting"  // Both were live, room created, links sent simultaneously
  // Shared post-video states
  | "mutual_interest"  // Both said yes (async) or both joined (live)
  | "video_sent"       // Video link sent to both
  | "video_expired"    // Room expired, follow-up sent
  | "contact_shared"   // Both consented to share contact info
  | "contact_declined" // One or both declined contact exchange
  | "feedback_given";  // Post-match feedback received

export function generateReferralCode(phoneHash: string): string {
  return "CUP-" + phoneHash.slice(0, 6).toUpperCase();
}

export function createDefaultProfile(phoneHash: string): UserProfile {
  const now = Timestamp.now();
  return {
    phoneHash,
    createdAt: now,
    updatedAt: now,
    onboardingComplete: false,
    onboardingStage: "greeting",
    demographics: {},
    preferences: {},
    personality: {},
    active: true,
    totalMatches: 0,
    creditsRemaining: 1,
    testUser: false,
    liveStatus: "offline",
    referralCode: generateReferralCode(phoneHash),
    referralCount: 0,
  };
}
