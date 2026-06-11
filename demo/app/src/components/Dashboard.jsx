import React, { useMemo, useState } from "react";
import { demoAdmin } from "../api";
import { scoreAllPairs } from "../scoring";
import { personaByHash } from "../personas";
import Lifecycle from "./Lifecycle";

const DIMENSION_LABELS = {
  intent: "Relationship intent",
  interests: "Shared interests",
  values: "Shared values",
  personality: "Personality fit",
};

function name(personas, hashOrUser) {
  const hash = typeof hashOrUser === "string" ? hashOrUser : hashOrUser.id ?? hashOrUser.phoneHash;
  return personaByHash(personas, hash)?.name ?? `Walk-in ${hash.slice(0, 6)}`;
}

export default function Dashboard({ personas, users, outbox }) {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [selectedPair, setSelectedPair] = useState(null); // {hashA, hashB}

  const pairs = useMemo(() => scoreAllPairs(users), [users]);
  const interesting = useMemo(
    () => pairs.filter((p) => p.score >= 40 || !p.passed).slice(0, 14),
    [pairs]
  );

  const matchedHashes = new Set(
    (lastRun?.summary?.pairs ?? []).flatMap((p) => [`${p.userA}|${p.userB}`, `${p.userB}|${p.userA}`])
  );

  const runMatching = async () => {
    setRunning(true);
    try {
      const res = await demoAdmin("runMatching");
      setLastRun(res);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="dashboard">
      <section className="dash-col users-col">
        <h2>Synthetic users <span className="count">{users.length}</span></h2>
        <div className="user-grid">
          {users.map((u) => {
            const p = personaByHash(personas, u.id);
            return (
              <div key={u.id} className="user-card">
                <div className="user-name">
                  {p?.name ?? `Walk-in`}
                  <span className="user-age">{u.demographics?.age}</span>
                </div>
                <div className="user-meta">
                  {u.preferences?.relationshipIntent} · {u.personality?.humorStyle ?? "?"} humor
                </div>
                <div className="user-tags">
                  {(u.personality?.interests ?? []).slice(0, 3).map((i) => (
                    <span key={i} className="tag">{i}</span>
                  ))}
                </div>
                {(u.preferences?.dealbreakers ?? []).map((d) => (
                  <span key={d} className="tag dealbreaker">🚫 {d}</span>
                ))}
                <div className={`user-credits ${u.creditsRemaining === 0 ? "zero" : ""}`}>
                  {u.creditsRemaining} credit{u.creditsRemaining === 1 ? "" : "s"}
                </div>
              </div>
            );
          })}
        </div>
        <div className="reseed-hint">
          Reset demo data: <code>node demo/seed.mjs --reset</code>
        </div>
      </section>

      <section className="dash-col pairs-col">
        <div className="pairs-header">
          <h2>Compatibility engine</h2>
          <button className="run-btn" onClick={runMatching} disabled={running}>
            {running ? "Matching… (Claude is writing proposals)" : "▶ Run Nightly Matching"}
          </button>
        </div>

        {lastRun?.summary && (
          <div className="run-summary">
            {lastRun.summary.pairsCreated} match{lastRun.summary.pairsCreated === 1 ? "" : "es"} created
            from {lastRun.summary.eligibleUsers} eligible users — proposals sent by SMS (see Phones tab)
          </div>
        )}

        <div className="pair-list">
          {interesting.map((p) => {
            const key = `${p.a.id}|${p.b.id}`;
            const isMatched = matchedHashes.has(key);
            return (
              <div
                key={key}
                className={`pair-card ${p.passed ? "" : "blocked"} ${isMatched ? "matched" : ""}`}
                onClick={() => p.passed && setSelectedPair({ hashA: p.a.id, hashB: p.b.id })}
              >
                <div className="pair-row">
                  <span className="pair-names">
                    {name(personas, p.a)} + {name(personas, p.b)}
                  </span>
                  {p.passed ? (
                    <span className={`pair-score s${Math.floor(p.score / 25)}`}>{p.score}</span>
                  ) : (
                    <span className="pair-blocked-badge">BLOCKED</span>
                  )}
                  {isMatched && <span className="matched-badge">MATCHED</span>}
                </div>
                {p.passed && p.breakdown && (
                  <div className="breakdown">
                    {Object.entries(p.breakdown).map(([k, d]) => (
                      <div key={k} className="dim">
                        <span className="dim-label">{DIMENSION_LABELS[k]}</span>
                        <div className="dim-bar">
                          <div className="dim-fill" style={{ width: `${(d.points / d.weight) * 100}%` }} />
                        </div>
                        <span className="dim-pts">{d.points.toFixed(0)}/{d.weight}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="pair-reasons">
                  {p.reasons.map((r) => (
                    <span key={r} className={`reason ${p.passed ? "" : "blocked"}`}>{r}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {selectedPair && (
        <Lifecycle
          personas={personas}
          hashA={selectedPair.hashA}
          hashB={selectedPair.hashB}
          onClose={() => setSelectedPair(null)}
        />
      )}
    </div>
  );
}
