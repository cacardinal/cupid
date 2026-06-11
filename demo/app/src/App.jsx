import React, { useEffect, useState, useCallback } from "react";
import { listUsers, listOutbox } from "./api";
import { loadPersonas } from "./personas";
import PhoneSim from "./components/PhoneSim";
import Dashboard from "./components/Dashboard";
import VideoRoom from "./components/VideoRoom";

const POLL_MS = 2500;

export default function App() {
  const videoMatch = window.location.pathname.match(/^\/video\/(.+)$/);

  const [personas, setPersonas] = useState(null);
  const [users, setUsers] = useState([]);
  const [outbox, setOutbox] = useState([]);
  const [tab, setTab] = useState("phones");
  const [health, setHealth] = useState({ firestore: false, functions: false });

  const refresh = useCallback(async () => {
    try {
      const u = await listUsers();
      setUsers(u);
      setHealth((h) => ({ ...h, firestore: true }));
    } catch {
      setHealth((h) => ({ ...h, firestore: false }));
    }
    try {
      const o = await listOutbox();
      o.sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
      setOutbox(o);
    } catch {
      /* covered by firestore health */
    }
  }, []);

  useEffect(() => {
    loadPersonas().then(setPersonas);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (videoMatch) {
    return <VideoRoom matchId={videoMatch[1]} personas={personas} />;
  }

  if (!personas) return <div className="loading">Loading personas…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-heart">💘</span> Cupid <span className="brand-sub">demo harness</span>
        </div>
        <nav className="tabs">
          <button className={tab === "phones" ? "active" : ""} onClick={() => setTab("phones")}>
            📱 Phones
          </button>
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>
            🧠 Matchmaker
          </button>
        </nav>
        <div className="health">
          <span className={health.firestore ? "dot ok" : "dot bad"} title="Firestore emulator" />
          <span className="health-label">{users.length} users</span>
          <a href="http://localhost:4000/firestore" target="_blank" rel="noreferrer" className="emu-link">
            Emulator UI ↗
          </a>
        </div>
      </header>

      {tab === "phones" && (
        <div className="phones-row">
          <PhoneSim
            label="Phone A"
            defaultPhone="+13145550101"
            personas={personas}
            users={users}
            outbox={outbox}
          />
          <PhoneSim
            label="Phone B"
            defaultPhone="+13145550102"
            personas={personas}
            users={users}
            outbox={outbox}
          />
        </div>
      )}

      {tab === "dashboard" && <Dashboard personas={personas} users={users} outbox={outbox} />}
    </div>
  );
}
