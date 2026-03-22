import axios from "axios";

const DAILY_API_BASE = "https://api.daily.co/v1";
const VIDEO_ROOM_DURATION_MINUTES = 20; // Room stays open 20 min (15 min call + 5 min buffer)

export interface DailyRoom {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  expiresAt: number;
}

function getHeaders() {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) throw new Error("Missing DAILY_API_KEY env var");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

// ─── Room management ──────────────────────────────────────────────────────────

export async function createAnonymousRoom(matchId: string): Promise<DailyRoom> {
  const expiryEpoch = Math.floor(Date.now() / 1000) + VIDEO_ROOM_DURATION_MINUTES * 60;

  const response = await axios.post(
    `${DAILY_API_BASE}/rooms`,
    {
      name: `cupid-${matchId}-${Date.now()}`,
      properties: {
        exp: expiryEpoch,
        // No names shown to participants
        enable_prejoin_ui: false,
        // Disable recordings for privacy
        enable_recording: "off",
        // Meeting tokens can enforce no-name display
        nbf: Math.floor(Date.now() / 1000) - 60, // Valid from 1 min ago
        // Room closes after all participants leave
        autodelete_room_after_expiry: true,
      },
    },
    { headers: getHeaders() }
  );

  const data = response.data;
  return {
    id: data.id,
    name: data.name,
    url: data.url,
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: expiryEpoch,
  };
}

export async function deleteRoom(roomName: string): Promise<void> {
  await axios.delete(`${DAILY_API_BASE}/rooms/${roomName}`, {
    headers: getHeaders(),
  });
}

export async function getRoomInfo(roomName: string): Promise<DailyRoom | null> {
  try {
    const response = await axios.get(`${DAILY_API_BASE}/rooms/${roomName}`, {
      headers: getHeaders(),
    });
    const data = response.data;
    return {
      id: data.id,
      name: data.name,
      url: data.url,
      createdAt: data.config?.nbf ?? 0,
      expiresAt: data.config?.exp ?? 0,
    };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

export function isRoomExpired(room: DailyRoom): boolean {
  return Date.now() / 1000 > room.expiresAt;
}
