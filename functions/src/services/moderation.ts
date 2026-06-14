import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import {
  ModerationFlag,
  ModerationStatus,
  AbuseEventType,
  AbuseSeverity,
} from "../models/abuse";

/**
 * Read + create/merge + resolve helpers for moderation_flags. Flags are created
 * and merged by the daily triage agent (private repo) through the authenticated
 * adminModeration endpoint via upsertModerationFlag. Admin-SDK only; no client
 * path (firestore.rules denies all client access).
 */

const FLAGS_COL = "moderation_flags";
const NOTES_MAX = 2000;
const EVIDENCE_MAX = 20;
const TYPES_MAX = 12;
const LIMIT_MIN = 1;
const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 50;

const db = () => admin.firestore();

export interface ListFlagsOptions {
  status?: ModerationStatus | "all";
  limit?: number;
}

export async function listModerationFlags(
  opts: ListFlagsOptions = {}
): Promise<ModerationFlag[]> {
  const status = opts.status ?? "open";
  const rawLimit = opts.limit ?? LIMIT_DEFAULT;
  const limit = Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.floor(rawLimit)));

  let query: admin.firestore.Query = db().collection(FLAGS_COL);
  if (status !== "all") {
    query = query.where("status", "==", status);
  }
  const snap = await query.orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ModerationFlag));
}

export interface UpsertFlagInput {
  phoneHash: string;
  types: AbuseEventType[];
  severity: AbuseSeverity;
  eventCount: number;
  evidence: string[];
}

/**
 * Create-or-merge the single OPEN flag for a phoneHash. The triage agent
 * recomputes the cluster each run and posts the current view, so an existing
 * open flag is overwritten with the fresh values (createdAt/notes preserved).
 * Keeps the "one open flag per phoneHash" invariant.
 */
export async function upsertModerationFlag(
  input: UpsertFlagInput
): Promise<ModerationFlag> {
  const col = db().collection(FLAGS_COL);
  const types = Array.from(new Set(input.types)).slice(0, TYPES_MAX);
  const evidence = (input.evidence ?? []).map((e) => String(e)).slice(0, EVIDENCE_MAX);
  const severity = input.severity;
  const eventCount = Math.max(0, Math.floor(input.eventCount || 0));

  const snap = await col
    .where("phoneHash", "==", input.phoneHash)
    .where("status", "==", "open")
    .limit(1)
    .get();

  if (!snap.empty) {
    const doc = snap.docs[0];
    const updates = { types, severity, eventCount, evidence };
    await doc.ref.update(updates);
    return { id: doc.id, ...doc.data(), ...updates } as ModerationFlag;
  }

  const flag: Omit<ModerationFlag, "id"> = {
    phoneHash: input.phoneHash,
    types,
    severity,
    eventCount,
    evidence,
    status: "open",
    notes: "",
    createdAt: Timestamp.now(),
    resolvedAt: null,
    resolvedBy: null,
  };
  const ref = await col.add(flag);
  return { id: ref.id, ...flag };
}

export interface ResolveFlagInput {
  status?: ModerationStatus;
  notes?: string;
  resolvedBy: string;
}

export type ResolveFlagResult =
  | { ok: true; flag: ModerationFlag }
  | { ok: false; reason: "not_found" | "invalid_status" };

export async function resolveModerationFlag(
  flagId: string,
  input: ResolveFlagInput
): Promise<ResolveFlagResult> {
  if (input.status !== undefined && input.status !== "open" && input.status !== "resolved") {
    return { ok: false, reason: "invalid_status" };
  }

  const ref = db().collection(FLAGS_COL).doc(flagId);

  return db().runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) {
      return { ok: false, reason: "not_found" } as ResolveFlagResult;
    }

    const updates: Record<string, unknown> = {};

    if (input.status !== undefined) {
      updates.status = input.status;
      if (input.status === "resolved") {
        updates.resolvedAt = Timestamp.now();
        updates.resolvedBy = input.resolvedBy;
      } else {
        // re-open clears the resolution stamp
        updates.resolvedAt = null;
        updates.resolvedBy = null;
      }
    }

    if (input.notes !== undefined) {
      updates.notes = input.notes.slice(0, NOTES_MAX);
    }

    tx.update(ref, updates);

    const merged = { id: doc.id, ...doc.data(), ...updates } as ModerationFlag;
    return { ok: true, flag: merged } as ResolveFlagResult;
  });
}
