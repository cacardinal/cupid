import axios from "axios";
import * as functions from "firebase-functions";

const DEEPGRAM_API_BASE = "https://api.deepgram.com/v1";

export interface TranscriptResult {
  transcript: string;
  confidence: number;
  words: Array<{ word: string; start: number; end: number; confidence: number }>;
}

function getHeaders() {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("Missing DEEPGRAM_API_KEY env var");
  return {
    Authorization: `Token ${apiKey}`,
    "Content-Type": "application/json",
  };
}

// ─── Transcribe audio from a URL (e.g. Twilio recording) ─────────────────────

/**
 * Transcribe an audio file from a URL (e.g. Twilio recording callback URL).
 * Uses Nova-2 model optimized for phone-call audio quality.
 */
export async function transcribeFromUrl(audioUrl: string): Promise<TranscriptResult> {
  functions.logger.info("Deepgram transcription started", { audioUrl });

  const response = await axios.post(
    `${DEEPGRAM_API_BASE}/listen`,
    { url: audioUrl },
    {
      headers: getHeaders(),
      params: {
        model: "nova-2",
        language: "en-US",
        smart_format: true,       // Punctuation + capitalization
        utterances: true,         // Segment by speaker pauses
        diarize: false,           // Single speaker (phone call)
        filler_words: false,      // Remove "um", "uh"
        numerals: true,           // Convert spoken numbers to digits
      },
    }
  );

  const result = response.data;
  const channel = result?.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];

  if (!alt?.transcript) {
    functions.logger.warn("Deepgram returned empty transcript", { result });
    return { transcript: "", confidence: 0, words: [] };
  }

  return {
    transcript: alt.transcript.trim(),
    confidence: alt.confidence ?? 0,
    words: alt.words ?? [],
  };
}

/**
 * Transcribe raw audio bytes (e.g. OGG from a Telegram voice message).
 */
export async function transcribeBuffer(
  audioBuffer: Buffer,
  mimetype = "audio/ogg"
): Promise<TranscriptResult> {
  const response = await axios.post(
    `${DEEPGRAM_API_BASE}/listen`,
    audioBuffer,
    {
      headers: {
        ...getHeaders(),
        "Content-Type": mimetype,
      },
      params: {
        model: "nova-2",
        language: "en-US",
        smart_format: true,
        filler_words: false,
        numerals: true,
      },
    }
  );

  const alt = response.data?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt?.transcript) {
    return { transcript: "", confidence: 0, words: [] };
  }

  return {
    transcript: alt.transcript.trim(),
    confidence: alt.confidence ?? 0,
    words: alt.words ?? [],
  };
}
