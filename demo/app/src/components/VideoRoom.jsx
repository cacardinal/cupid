import React, { useEffect, useState } from "react";
import { listMatches } from "../api";
import { loadPersonas } from "../personas";

const CALL_SECONDS = 15 * 60;

// Mock anonymous video date — stands in for the Daily.co room in demo mode.
export default function VideoRoom({ matchId }) {
  const [names, setNames] = useState(["?", "?"]);
  const [left, setLeft] = useState(CALL_SECONDS);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    (async () => {
      const personas = await loadPersonas();
      for (const p of personas) {
        try {
          const matches = await listMatches(p.phoneHash);
          const m = matches.find((x) => x.id === matchId);
          if (m) {
            const other = personas.find((q) => q.phoneHash === m.matchedUserId);
            setNames([p.name, other?.name ?? "Mystery match"]);
            return;
          }
        } catch {
          /* keep scanning */
        }
      }
    })();
  }, [matchId]);

  useEffect(() => {
    if (ended) return;
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [ended]);

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");

  if (ended) {
    return (
      <div className="video-room ended">
        <h1>Call ended</h1>
        <p>Cupid will text you both to ask how it went.</p>
        <a href="/">← back to harness</a>
      </div>
    );
  }

  return (
    <div className="video-room">
      <div className="video-banner">
        🔒 Anonymous video date · no names shared until you both say yes · {mm}:{ss}
      </div>
      <div className="video-split">
        {names.map((n, i) => (
          <div key={i} className="video-pane">
            <div className="video-avatar">{n[0]}</div>
            <div className="video-name">{i === 0 ? n : "Your match"}</div>
            <div className="video-fake-cam" />
          </div>
        ))}
      </div>
      <div className="video-controls">
        <button className="video-btn mute">🎤</button>
        <button className="video-btn cam">📷</button>
        <button className="video-btn leave" onClick={() => setEnded(true)}>
          Leave
        </button>
      </div>
    </div>
  );
}
