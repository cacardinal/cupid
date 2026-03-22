import { detectLiveIntent, detectCancelLiveIntent, detectYesNoIntent, detectHelpIntent } from "../services/intentDetector";

// ─── detectLiveIntent ─────────────────────────────────────────────────────────

describe("detectLiveIntent", () => {
  const positives = [
    "ready now",
    "I'm ready now",
    "available now",
    "connect me now",
    "im free right now",
    "I'm free right now",
    "go live",
    "live mode",
    "match me now",
    "let's connect now",
    "ready to meet",
    "instant match",
  ];

  const negatives = [
    "hey how are you",
    "what are you looking for",
    "tell me more about yourself",
    "I had a great time on the call",
    "no thanks",
    "not interested",
    "I want to cancel my account",
  ];

  test.each(positives)("detects live intent: %s", (msg) => {
    expect(detectLiveIntent(msg)).toBe(true);
  });

  test.each(negatives)("does not trigger on: %s", (msg) => {
    expect(detectLiveIntent(msg)).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(detectLiveIntent("READY NOW")).toBe(true);
    expect(detectLiveIntent("GO LIVE")).toBe(true);
  });
});

// ─── detectCancelLiveIntent ───────────────────────────────────────────────────

describe("detectCancelLiveIntent", () => {
  test("detects cancel from 'never mind'", () => {
    expect(detectCancelLiveIntent("never mind")).toBe(true);
  });

  test("detects cancel from 'stop looking'", () => {
    expect(detectCancelLiveIntent("stop looking please")).toBe(true);
  });

  test("detects cancel from 'go offline'", () => {
    expect(detectCancelLiveIntent("go offline")).toBe(true);
  });

  test("detects cancel from 'forget it'", () => {
    expect(detectCancelLiveIntent("forget it")).toBe(true);
  });

  test("does not trigger on unrelated message", () => {
    expect(detectCancelLiveIntent("I'm looking for a long-term relationship")).toBe(false);
  });
});

// ─── detectYesNoIntent ────────────────────────────────────────────────────────

describe("detectYesNoIntent", () => {
  const yesMessages = [
    "yes",
    "yeah",
    "yep",
    "sure",
    "definitely",
    "absolutely",
    "sounds good",
    "I'm in",
    "let's do it",
    "ok",
    "okay",
    "y",
    "👍",
  ];

  const noMessages = [
    "no",
    "nah",
    "nope",
    "not interested",
    "pass",
    "no thanks",
    "skip",
    "n",
    "👎",
  ];

  const ambiguous = [
    "maybe",
    "let me think",
    "tell me more",
    "what do they look like",
    "hmm",
  ];

  test.each(yesMessages)("classifies '%s' as yes", (msg) => {
    expect(detectYesNoIntent(msg)).toBe("yes");
  });

  test.each(noMessages)("classifies '%s' as no", (msg) => {
    expect(detectYesNoIntent(msg)).toBe("no");
  });

  test.each(ambiguous)("classifies '%s' as ambiguous", (msg) => {
    expect(detectYesNoIntent(msg)).toBe("ambiguous");
  });
});

// ─── detectHelpIntent ─────────────────────────────────────────────────────────

describe("detectHelpIntent", () => {
  test("detects 'help'", () => {
    expect(detectHelpIntent("help")).toBe(true);
  });

  test("detects 'how does this work'", () => {
    expect(detectHelpIntent("how does this work?")).toBe(true);
  });

  test("detects 'commands'", () => {
    expect(detectHelpIntent("what are my commands")).toBe(true);
  });

  test("does not trigger on normal message", () => {
    expect(detectHelpIntent("I like hiking and cooking")).toBe(false);
  });
});
