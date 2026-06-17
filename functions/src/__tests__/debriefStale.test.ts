/**
 * closeStaleDebriefs force-closes debriefs left idle past DEBRIEF_STALE_MS so a
 * match never freezes in "debriefing" (user ghosted / no confident read). An
 * ACTIVE debrief (fresh updatedAt) is left alone to finish. The two-step
 * exchange gate is invoked after the force-close to drive a terminal.
 */

const fs = {
  getAllActiveUsers: jest.fn(),
  getActiveMatchForUser: jest.fn(),
  updateMatchRecord: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../services/firestore", () => fs);

const sms = { maybeOfferContactExchange: jest.fn().mockResolvedValue(undefined) };
jest.mock("../webhooks/sms", () => sms);

jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { closeStaleDebriefs } from "../scheduler/jobs";

const millisAgo = (ms: number) => ({ toMillis: () => Date.now() - ms });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DEBRIEF_STALE_MS = "30000"; // 30s threshold for the test
});

describe("closeStaleDebriefs", () => {
  test("force-closes an idle debrief and runs the exchange gate", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1",
      status: "debriefing",
      matchedUserId: "u2",
      updatedAt: millisAgo(60_000), // idle 60s > 30s threshold
    });

    const { closed } = await closeStaleDebriefs([{ phoneHash: "u1" }]);

    expect(closed).toBe(1);
    expect(fs.updateMatchRecord).toHaveBeenCalledWith("u1", "m1", {
      feedbackGiven: true,
      fit: "unsure",
      status: "feedback_given",
    });
    expect(sms.maybeOfferContactExchange).toHaveBeenCalledWith("u1", "u2", "m1");
  });

  test("leaves an active (recently-updated) debrief alone", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1",
      status: "debriefing",
      matchedUserId: "u2",
      updatedAt: millisAgo(5_000), // active 5s < 30s threshold
    });

    const { closed } = await closeStaleDebriefs([{ phoneHash: "u1" }]);

    expect(closed).toBe(0);
    expect(fs.updateMatchRecord).not.toHaveBeenCalled();
    expect(sms.maybeOfferContactExchange).not.toHaveBeenCalled();
  });

  test("honors an existing fit read when force-closing", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({
      id: "m1",
      status: "debriefing",
      matchedUserId: "u2",
      fit: "positive",
      updatedAt: millisAgo(60_000),
    });

    await closeStaleDebriefs([{ phoneHash: "u1" }]);

    expect(fs.updateMatchRecord).toHaveBeenCalledWith("u1", "m1", {
      feedbackGiven: true,
      fit: "positive",
      status: "feedback_given",
    });
  });

  test("ignores non-debriefing matches", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({ id: "m1", status: "scheduled", matchedUserId: "u2" });

    const { closed } = await closeStaleDebriefs([{ phoneHash: "u1" }]);

    expect(closed).toBe(0);
    expect(fs.updateMatchRecord).not.toHaveBeenCalled();
  });
});
