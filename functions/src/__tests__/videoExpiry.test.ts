/**
 * runVideoExpiryFollowUp opens the post-date DEBRIEF stage exactly once per
 * match: a video_sent match transitions to "debriefing" (not the old
 * "video_expired"), the opener is sent, and debriefTurnCount is initialized.
 */

const fs = {
  getAllActiveUsers: jest.fn(),
  getActiveMatchForUser: jest.fn(),
  updateMatchRecord: jest.fn().mockResolvedValue(undefined),
  getPhoneByHash: jest.fn().mockResolvedValue("+13145550000"),
  appendConversationTurn: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../services/firestore", () => fs);

const claude = { generatePostVideoFollowUp: jest.fn().mockResolvedValue({ message: "how did it go?" }) };
jest.mock("../services/claude", () => claude);

const twilio = { sendSms: jest.fn().mockResolvedValue("sid") };
jest.mock("../services/twilio", () => twilio);

jest.mock("../services/analytics", () => ({ track: jest.fn() }));
jest.mock("firebase-functions", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runVideoExpiryFollowUp } from "../scheduler/jobs";

beforeEach(() => {
  jest.clearAllMocks();
  fs.getPhoneByHash.mockResolvedValue("+13145550000");
  fs.getAllActiveUsers.mockResolvedValue([{ phoneHash: "u1" }]);
});

describe("runVideoExpiryFollowUp opens the debrief stage", () => {
  test("video_sent (forced) -> debriefing, opener sent, turn count reset", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({ id: "m1", status: "video_sent", matchedUserId: "u2" });

    const summary = await runVideoExpiryFollowUp(true);

    expect(fs.updateMatchRecord).toHaveBeenCalledWith("u1", "m1", {
      status: "debriefing",
      debriefTurnCount: 0,
    });
    expect(twilio.sendSms).toHaveBeenCalledWith("+13145550000", "how did it go?");
    expect(summary.followUpsSent).toBe(1);
  });

  test("does not fire on a non-video_sent match (fires once per match)", async () => {
    fs.getActiveMatchForUser.mockResolvedValue({ id: "m1", status: "debriefing", matchedUserId: "u2" });

    const summary = await runVideoExpiryFollowUp(true);

    expect(fs.updateMatchRecord).not.toHaveBeenCalled();
    expect(summary.followUpsSent).toBe(0);
  });
});
