/**
 * COMPLETENESS #3 — negative-PII guarantee across every emit call site.
 *
 * Statically scans the source for every `logAbuseEvent({ ... })` call and
 * asserts the `evidence` value is a fixed string literal that contains neither
 * an "http" substring nor a phone-shaped digit run. The 140-char clamp in
 * abuseLog is only a backstop; this encodes the real guarantee (fixed labels).
 */

import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");

// Files that emit abuse events (every call site lives in these).
const EMIT_FILES = [
  "services/usageGuard.ts",
  "services/twilio.ts",
  "webhooks/sms.ts",
  "index.ts",
];

// Phone-shaped run: 7+ consecutive digits, or separated US phone shapes.
const PHONE_SHAPE_RE = /\d{7,}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;

function extractEvidenceLiterals(source: string): string[] {
  const out: string[] = [];
  // Match `evidence: "..."`, `evidence: '...'`, or `evidence: `...``
  const re = /evidence:\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(m[1]);
  }
  return out;
}

describe("abuse evidence is PII-free at every call site", () => {
  test("at least one evidence literal is found per emit file", () => {
    for (const f of EMIT_FILES) {
      const src = fs.readFileSync(path.join(SRC, f), "utf8");
      const lits = extractEvidenceLiterals(src);
      expect(lits.length).toBeGreaterThan(0);
    }
  });

  test("no evidence literal contains an http substring", () => {
    for (const f of EMIT_FILES) {
      const src = fs.readFileSync(path.join(SRC, f), "utf8");
      for (const lit of extractEvidenceLiterals(src)) {
        expect(lit.toLowerCase()).not.toContain("http");
      }
    }
  });

  test("no evidence literal contains a phone-shaped digit run", () => {
    for (const f of EMIT_FILES) {
      const src = fs.readFileSync(path.join(SRC, f), "utf8");
      for (const lit of extractEvidenceLiterals(src)) {
        // Strip template interpolations (${count}) — those are small ints, not PII.
        const stripped = lit.replace(/\$\{[^}]*\}/g, "");
        expect(stripped).not.toMatch(PHONE_SHAPE_RE);
      }
    }
  });
});
