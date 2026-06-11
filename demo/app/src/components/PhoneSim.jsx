import React, { useEffect, useMemo, useRef, useState } from "react";
import { listConversation, sendInboundSms, hashPhone } from "../api";
import { personaByPhone } from "../personas";
import Paywall from "./Paywall";

const POLL_MS = 2000;

// Render URLs as links inside message bubbles.
function Linkify({ text }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    )
  );
}

export default function PhoneSim({ label, defaultPhone, personas, users, outbox }) {
  const [phone, setPhone] = useState(defaultPhone);
  const [customPhone, setCustomPhone] = useState("+13145550199");
  const [hash, setHash] = useState(null);
  const [turns, setTurns] = useState([]);
  const [draft, setDraft] = useState("");
  const [sentAt, setSentAt] = useState(null); // local time of last outbound send
  const [showPaywall, setShowPaywall] = useState(false);
  const scrollRef = useRef(null);

  const persona = personaByPhone(personas, phone);
  const user = users.find((u) => u.id === hash) ?? null;
  const credits = user?.creditsRemaining ?? null;

  useEffect(() => {
    let live = true;
    hashPhone(phone).then((h) => live && setHash(h));
    setTurns([]);
    setSentAt(null);
    return () => {
      live = false;
    };
  }, [phone]);

  useEffect(() => {
    if (!hash) return;
    let live = true;
    const poll = async () => {
      try {
        const t = await listConversation(hash);
        t.sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
        if (live) setTurns(t);
      } catch {
        /* user may not exist yet */
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [hash]);

  // Merge conversation turns with outbox messages for this phone, deduping
  // assistant turns that were also "sent" as SMS (same content).
  const messages = useMemo(() => {
    const convo = turns.map((t) => ({
      key: `c-${t.id}`,
      role: t.role,
      text: t.content,
      ts: t.timestamp?.getTime() ?? 0,
    }));
    const convoTexts = new Set(convo.filter((m) => m.role === "assistant").map((m) => m.text));
    const extra = outbox
      .filter((o) => o.to === phone)
      .filter((o) => ![...convoTexts].some((t) => o.body === t || o.body.startsWith(t)))
      .map((o) => ({
        key: `o-${o.id}`,
        role: "assistant",
        text: o.body,
        ts: o.sentAt?.getTime() ?? 0,
      }));
    return [...convo, ...extra].sort((a, b) => a.ts - b.ts);
  }, [turns, outbox, phone]);

  // Typing indicator: we sent something and no assistant message has landed since.
  const waiting =
    sentAt && !messages.some((m) => m.role === "assistant" && m.ts > sentAt - 2000)
      ? Date.now() - sentAt < 60000
      : false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, waiting]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setSentAt(Date.now());
    // Optimistic render happens naturally: the webhook writes the user turn
    // to Firestore within ~1s and the poll picks it up.
    await sendInboundSms(phone, text);
  };

  return (
    <div className="phone-wrap">
      <div className="phone-controls">
        <span className="phone-label">{label}</span>
        <select value={phone} onChange={(e) => setPhone(e.target.value)}>
          {personas.map((p) => (
            <option key={p.phone} value={p.phone}>
              {p.name} · {p.phone}
            </option>
          ))}
          <option value={customPhone}>New user · {customPhone}</option>
        </select>
        {phone === customPhone && (
          <input
            className="custom-phone"
            value={customPhone}
            onChange={(e) => {
              setCustomPhone(e.target.value);
              setPhone(e.target.value);
            }}
          />
        )}
      </div>

      <div className="iphone">
        <div className="iphone-notch" />
        <div className="iphone-header">
          <div className="contact-avatar">💘</div>
          <div className="contact-name">Cupid</div>
          {credits != null && (
            <button
              className={`credits-pill ${credits === 0 ? "zero" : ""}`}
              onClick={() => setShowPaywall(true)}
              title="Intro credits"
            >
              {credits === 0 ? "0 credits — top up" : `${credits} credit${credits === 1 ? "" : "s"}`}
            </button>
          )}
        </div>

        <div className="bubbles" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty-convo">
              {persona
                ? "Loading conversation…"
                : "Fresh number. Say hi to start onboarding with live Claude."}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.key} className={`bubble ${m.role === "user" ? "sent" : "received"}`}>
              <Linkify text={m.text} />
            </div>
          ))}
          {waiting && (
            <div className="bubble received typing">
              <span /><span /><span />
            </div>
          )}
        </div>

        <div className="composer">
          <input
            value={draft}
            placeholder="Text Cupid…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button onClick={send} disabled={!draft.trim()}>
            ↑
          </button>
        </div>
      </div>

      {persona && <div className="persona-blurb">{persona.blurb}</div>}

      {showPaywall && hash && (
        <Paywall
          phoneHash={hash}
          credits={credits ?? 0}
          personaName={persona?.name ?? "this user"}
          onClose={() => setShowPaywall(false)}
        />
      )}
    </div>
  );
}
