import { Timestamp } from "firebase-admin/firestore";

export type Gender = "man" | "woman" | "non-binary" | "other" | "prefer_not_to_say";
export type Orientation = "straight" | "gay" | "lesbian" | "bisexual" | "other";
export type RelationshipIntent = "long-term" | "casual" | "open" | "unsure";
export type HumorStyle = "dry" | "sarcastic" | "silly" | "witty" | "deadpan" | "none";
export type CommunicationStyle = "texter" | "caller" | "in-person" | "mixed";

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
  quietHoursStart?: number;    // 0-23, hour in user's timezone
  quietHoursEnd?: number;
  totalMatches: number;
  creditsRemaining: number;    // Intro credits purchased
  testUser: boolean;           // Seed users for beta
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
}

export type MatchStatus =
  | "proposed"        // Cupid reached out, awaiting user response
  | "user_accepted"   // This user said yes, waiting for other
  | "user_declined"   // This user said no
  | "mutual_interest" // Both said yes, video room created
  | "video_sent"      // Video link sent to both
  | "video_expired"   // Room expired, follow-up sent
  | "contact_shared"  // Both consented to share contact info
  | "contact_declined"// One or both declined contact exchange
  | "feedback_given"; // Post-match feedback received

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
    creditsRemaining: 1, // One free intro for new users
    testUser: false,
  };
}
