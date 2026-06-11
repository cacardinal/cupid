import data from "../../personas.json";
import { hashPhone } from "./api";

// Personas with phoneHash resolved (async because Web Crypto).
let cached = null;

export async function loadPersonas() {
  if (cached) return cached;
  cached = await Promise.all(
    data.personas.map(async (p) => ({ ...p, phoneHash: await hashPhone(p.phone) }))
  );
  return cached;
}

export function personaByHash(personas, hash) {
  return personas.find((p) => p.phoneHash === hash) ?? null;
}

export function personaByPhone(personas, phone) {
  return personas.find((p) => p.phone === phone) ?? null;
}
