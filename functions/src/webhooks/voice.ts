import * as functions from "firebase-functions";
import { Request, Response } from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { twiml as TwimlVoice } from "twilio";
import { getOrCreateUser, getConversationHistory, appendConversationTurn, updateUser } from "../services/firestore";
import { generateConversationReply, mergeProfileUpdates } from "../services/claude";
import { transcribeFromUrl } from "../services/deepgram";
import { detectLiveIntent } from "../services/intentDetector";
import { setUserLive } from "../services/liveMatching";

// ─── Twilio voice webhook — initial call ──────────────────────────────────────
//
// Called when a user dials the Cupid phone number.
// Responds with TwiML to greet and start gathering speech.

export async function handleInboundCall(req: Request, res: Response): Promise<void> {
  const from: string = req.body?.From ?? "";
  if (!from) {
    res.status(400).send("Missing From");
    return;
  }

  functions.logger.info("Inbound voice call", { from: maskPhone(from) });

  try {
    const { profile, isNew } = await getOrCreateUser(from);

    // Build greeting based on onboarding stage
    let greeting: string;
    if (isNew || profile.onboardingStage === "greeting") {
      greeting =
        "Hi! I'm Cupid, your personal AI matchmaker. " +
        "I'm going to ask you a few questions so I can find you a great match. " +
        "This usually takes about five minutes. Ready? Let's start — what's your first name?";
    } else if (profile.onboardingComplete) {
      greeting =
        "Hey, welcome back! Great to hear your voice. What's on your mind? " +
        "You can update your preferences, ask about your matches, or just chat.";
    } else {
      greeting =
        "Hey, welcome back! We were in the middle of getting to know you. " +
        "Let's pick up where we left off.";
    }

    const response = buildGatherTwiml(greeting);
    res.type("text/xml").send(response);
  } catch (err) {
    functions.logger.error("Voice call handler error", err);
    res.type("text/xml").send(buildErrorTwiml());
  }
}

// ─── Twilio voice webhook — speech input received ─────────────────────────────
//
// Called after Twilio records a user utterance.
// Uses Deepgram for transcription, then routes through Claude pipeline.

export async function handleVoiceGather(req: Request, res: Response): Promise<void> {
  const from: string = req.body?.From ?? "";
  const callSid: string = req.body?.CallSid ?? "";
  const speechResult: string = (req.body?.SpeechResult ?? "").trim();
  const recordingUrl: string = req.body?.RecordingUrl ?? "";

  if (!from) {
    res.status(400).send("Missing From");
    return;
  }

  functions.logger.info("Voice gather received", {
    from: maskPhone(from),
    callSid,
    hasSpeechResult: !!speechResult,
    hasRecording: !!recordingUrl,
  });

  try {
    const { profile } = await getOrCreateUser(from);
    const phoneHash = profile.phoneHash;

    // Transcribe: prefer Deepgram over Twilio's built-in speech result for quality
    let userText = speechResult;
    if (recordingUrl && !speechResult) {
      const transcriptResult = await transcribeFromUrl(recordingUrl);
      userText = transcriptResult.transcript;
      functions.logger.info("Deepgram transcript", {
        text: userText,
        confidence: transcriptResult.confidence,
      });
    }

    if (!userText) {
      const response = buildGatherTwiml(
        "Sorry, I didn't catch that. Could you say that again?",
        true
      );
      res.type("text/xml").send(response);
      return;
    }

    // Check for live mode intent ("I'm available now", "ready to connect", etc.)
    const liveIntent = detectLiveIntent(userText);
    if (liveIntent && profile.onboardingComplete) {
      await setUserLive(phoneHash, from);
      const voiceResponse = new TwimlVoice.VoiceResponse();
      voiceResponse.say(
        { voice: "Polly.Joanna-Neural" },
        "Love it. Let me see who's around. I'll text you if I find someone great."
      );
      voiceResponse.hangup();
      res.type("text/xml").send(voiceResponse.toString());
      return;
    }

    // Save user turn (voice-sourced)
    await appendConversationTurn(phoneHash, {
      role: "user",
      content: userText,
      timestamp: Timestamp.now(),
    });

    // Run through Claude pipeline
    const history = await getConversationHistory(phoneHash);
    const result = await generateConversationReply(
      userText,
      history,
      profile,
      profile.onboardingStage
    );

    // Save assistant turn
    await appendConversationTurn(phoneHash, {
      role: "assistant",
      content: result.message,
      timestamp: Timestamp.now(),
    });

    // Merge profile updates
    if (result.profileUpdates) {
      const profileUpdates = mergeProfileUpdates(profile, result.profileUpdates);
      if (Object.keys(profileUpdates).length > 0) {
        await updateUser(phoneHash, profileUpdates);
      }
    }

    // If onboarding just completed, add a voice-specific completion message
    let responseText = result.message;
    if (result.profileUpdates?.onboardingComplete && !profile.onboardingComplete) {
      responseText +=
        " I'll also send you a text so you have everything in writing. Talk soon!";
    }

    // Respond via TwiML — continue gathering or hang up if done
    const isDone =
      result.profileUpdates?.onboardingComplete ||
      userText.toLowerCase().includes("bye") ||
      userText.toLowerCase().includes("goodbye");

    if (isDone) {
      const voiceResponse = new TwimlVoice.VoiceResponse();
      voiceResponse.say({ voice: "Polly.Joanna-Neural" }, responseText);
      voiceResponse.hangup();
      res.type("text/xml").send(voiceResponse.toString());
    } else {
      const twiml = buildGatherTwiml(responseText);
      res.type("text/xml").send(twiml);
    }
  } catch (err) {
    functions.logger.error("Voice gather handler error", err);
    res.type("text/xml").send(buildErrorTwiml());
  }
}

// ─── Twilio recording status callback ─────────────────────────────────────────
//
// Fires when a recording is ready. We use this as an alternative trigger
// for high-quality Deepgram transcription on longer utterances.

export async function handleVoiceRecording(req: Request, res: Response): Promise<void> {
  const recordingUrl: string = req.body?.RecordingUrl ?? "";
  const callSid: string = req.body?.CallSid ?? "";
  const from: string = req.body?.From ?? "";

  functions.logger.info("Voice recording ready", { callSid, recordingUrl: !!recordingUrl });

  if (!recordingUrl || !from) {
    res.status(400).send("Missing RecordingUrl or From");
    return;
  }

  try {
    // Transcribe via Deepgram
    const result = await transcribeFromUrl(recordingUrl);

    if (result.transcript) {
      // Route the transcript through the same pipeline as text
      // This runs asynchronously — response is delivered via SMS follow-up
      const { getOrCreateUser, getConversationHistory, appendConversationTurn, updateUser } =
        await import("../services/firestore");
      const { generateConversationReply, mergeProfileUpdates } = await import("../services/claude");
      const { sendSms } = await import("../services/twilio");

      const { profile } = await getOrCreateUser(from);
      const phoneHash = profile.phoneHash;

      await appendConversationTurn(phoneHash, {
        role: "user",
        content: result.transcript,
        timestamp: Timestamp.now(),
      });

      const history = await getConversationHistory(phoneHash);
      const claudeResult = await generateConversationReply(
        result.transcript,
        history,
        profile,
        profile.onboardingStage
      );

      await appendConversationTurn(phoneHash, {
        role: "assistant",
        content: claudeResult.message,
        timestamp: Timestamp.now(),
      });

      if (claudeResult.profileUpdates) {
        const profileUpdates = mergeProfileUpdates(profile, claudeResult.profileUpdates);
        if (Object.keys(profileUpdates).length > 0) {
          await updateUser(phoneHash, profileUpdates);
        }
      }

      // Deliver response via SMS (async recording path = no active call to respond to)
      await sendSms(from, claudeResult.message);
    }

    res.status(200).send("OK");
  } catch (err) {
    functions.logger.error("Voice recording handler error", err);
    res.status(500).send("Internal error");
  }
}

// ─── Call status callback ──────────────────────────────────────────────────────

export async function handleCallStatus(req: Request, res: Response): Promise<void> {
  const callSid = req.body?.CallSid ?? "";
  const status = req.body?.CallStatus ?? "";
  functions.logger.info("Call status update", { callSid, status });
  res.status(200).send("OK");
}

// ─── TwiML helpers ────────────────────────────────────────────────────────────

/**
 * Build a Gather-based TwiML response. Twilio will speak the message
 * and then listen for user speech, posting to /voiceGather.
 */
function buildGatherTwiml(message: string, isRetry = false): string {
  const response = new TwimlVoice.VoiceResponse();

  const gather = response.gather({
    input: ["speech"],
    action: "/voiceGather",
    method: "POST",
    speechModel: "phone_call",
    speechTimeout: "auto",       // Detect end of speech automatically
    timeout: 8,                  // Seconds of silence before assuming done
    enhanced: true,              // Better accuracy for phone audio
  });

  gather.say({ voice: "Polly.Joanna-Neural" }, message);

  // Fallback if no speech detected
  if (isRetry) {
    response.say(
      { voice: "Polly.Joanna-Neural" },
      "I'm having trouble hearing you. Feel free to text me instead — I'm at the same number. Take care!"
    );
    response.hangup();
  } else {
    // Redirect back to gather if silence
    response.redirect({ method: "POST" }, "/voiceGather");
  }

  return response.toString();
}

function buildErrorTwiml(): string {
  const response = new TwimlVoice.VoiceResponse();
  response.say(
    { voice: "Polly.Joanna-Neural" },
    "Sorry, I ran into an issue on my end. Please text me at this number instead!"
  );
  response.hangup();
  return response.toString();
}

function maskPhone(phone: string): string {
  return phone.slice(0, 5) + "****" + phone.slice(-2);
}
