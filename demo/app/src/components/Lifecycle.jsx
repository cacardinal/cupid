import React, { useEffect, useState } from "react";
import { listMatches, demoAdmin } from "../api";
import { personaByHash } from "../personas";

const STAGES = [
  "proposed",
  "user_accepted",
  "video_sent",
  "video_expired",
  "contact_shared",
];

const STAGE_LABELS = {
  proposed: "Proposed",
  user_accepted: "Accepted (one side)",
  mutual_interest: "Mutual interest",
  video_sent: "Video link sent",
  video_expired: "Call ended",
  contact_shared: "Contacts exchanged",
  user_declined: "Declined",
  contact_declined: "Contact declined",
};

export default function Lifecycle({ personas, hashA, hashB, onClose }) {
  const [matchA, setMatchA] = useState(null);
  const [matchB, setMatchB] = useState(null);
  const [expiring, setExpiring] = useState(false);

  const nameA = personaByHash(personas, hashA)?.name ?? "User A";
  const nameB = personaByHash(personas, hashB)?.name ?? "User B";

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const [ma, mb] = await Promise.all([listMatches(hashA), listMatches(hashB)]);
        const newest = (arr, other) =>
          arr
            .filter((m) => m.matchedUserId === other)
            .sort((x, y) => (y.proposedAt?.getTime() ?? 0) - (x.proposedAt?.getTime() ?? 0))[0] ?? null;
        if (live) {
          setMatchA(newest(ma, hashB));
          setMatchB(newest(mb, hashA));
        }
      } catch {
        /* retry next poll */
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [hashA, hashB]);

  const stageIndex = (status) => {
    const i = STAGES.indexOf(status);
    return i === -1 ? 0 : i;
  };
  const overall = Math.max(stageIndex(matchA?.status), stageIndex(matchB?.status));

  const forceExpire = async () => {
    setExpiring(true);
    try {
      await demoAdmin("expireVideo");
    } finally {
      setExpiring(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal lifecycle" onClick={(e) => e.stopPropagation()}>
        <h2>
          {nameA} + {nameB}
          {matchA?.compatibilityScore != null && (
            <span className="lifecycle-score">{matchA.compatibilityScore}</span>
          )}
        </h2>

        {!matchA && !matchB ? (
          <p className="lifecycle-empty">
            No match record yet — run Nightly Matching first, then click the pair again.
          </p>
        ) : (
          <>
            <div className="timeline">
              {STAGES.map((s, i) => (
                <div key={s} className={`timeline-step ${i <= overall ? "done" : ""}`}>
                  <span className="timeline-dot" />
                  <span className="timeline-label">{STAGE_LABELS[s]}</span>
                </div>
              ))}
            </div>

            <div className="match-sides">
              {[
                { who: nameA, m: matchA },
                { who: nameB, m: matchB },
              ].map(({ who, m }) => (
                <div key={who} className="match-side">
                  <h3>{who}'s record</h3>
                  {m ? (
                    <ul>
                      <li>status: <b>{STAGE_LABELS[m.status] ?? m.status}</b></li>
                      <li>accepted: {m.userAccepted === true ? "✓ yes" : m.userAccepted === false ? "✗ no" : "— pending"}</li>
                      {m.videoRoomUrl && (
                        <li>
                          room: <a href={m.videoRoomUrl} target="_blank" rel="noreferrer">join ↗</a>
                        </li>
                      )}
                      {m.contactExchanged && <li>contact exchanged ✓</li>}
                    </ul>
                  ) : (
                    <p>no record</p>
                  )}
                </div>
              ))}
            </div>

            <div className="lifecycle-actions">
              <span className="hint">
                Drive it from the Phones tab: both reply "yes" to the proposal → video link appears.
              </span>
              {(matchA?.status === "video_sent" || matchB?.status === "video_sent") && (
                <button onClick={forceExpire} disabled={expiring}>
                  {expiring ? "Expiring…" : "⏭ Force video expiry (skip the 20-min wait)"}
                </button>
              )}
            </div>
          </>
        )}

        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
