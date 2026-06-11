import React, { useState } from "react";
import { patchUserCredits } from "../api";

// Pricing from docs/PRD.md. Demo checkout only — no payment processor wired.
const PACKS = [
  { label: "1 introduction", price: "$29", credits: 1 },
  { label: "3-pack", price: "$69", credits: 3, badge: "popular" },
  { label: "8-pack", price: "$149", credits: 8 },
  { label: "Unlimited month", price: "$99/mo", credits: 30 },
];

export default function Paywall({ phoneHash, credits, personaName, onClose }) {
  const [selected, setSelected] = useState(1);
  const [card, setCard] = useState("4242 4242 4242 4242");
  const [state, setState] = useState("idle"); // idle | paying | done

  const pay = async () => {
    setState("paying");
    await new Promise((r) => setTimeout(r, 1200)); // checkout theater
    await patchUserCredits(phoneHash, credits + PACKS[selected].credits);
    setState("done");
    setTimeout(onClose, 1600);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal paywall" onClick={(e) => e.stopPropagation()}>
        <div className="demo-badge">DEMO CHECKOUT — no live charges</div>
        <h2>Out of introductions</h2>
        <p className="paywall-sub">
          {personaName} has {credits} intro credit{credits === 1 ? "" : "s"} left. Each introduction
          is hand-vetted by Cupid — pay per intro, not per swipe.
        </p>

        <div className="packs">
          {PACKS.map((p, i) => (
            <button
              key={p.label}
              className={`pack ${selected === i ? "selected" : ""}`}
              onClick={() => setSelected(i)}
            >
              {p.badge && <span className="pack-badge">{p.badge}</span>}
              <span className="pack-price">{p.price}</span>
              <span className="pack-label">{p.label}</span>
            </button>
          ))}
        </div>

        <label className="card-label">
          Card number
          <input value={card} onChange={(e) => setCard(e.target.value)} />
        </label>

        {state === "done" ? (
          <div className="pay-success">✓ {PACKS[selected].credits} credits added</div>
        ) : (
          <button className="pay-btn" onClick={pay} disabled={state === "paying"}>
            {state === "paying" ? "Processing…" : `Pay ${PACKS[selected].price}`}
          </button>
        )}

        <button className="modal-close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
