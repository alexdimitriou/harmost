import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { PRODUCT_NAME } from "./name.js";
import { decisionSection } from "./hook.js";
import type { AdrRecord } from "./ledger.js";

/**
 * What was ratified, recorded so that un-ratifying is an act rather than an edit.
 *
 * The ledger and the gate's config are both files in the repository being
 * changed, so a gate cannot defend itself: any rule an author may edit is not a
 * rule that holds against that author. This file does not change that — it makes
 * weakening *loud*. Combined with ownership on the path (CODEOWNERS), it makes
 * weakening require someone else's approval, which is the only form of this
 * guarantee that survives an author who does not want it.
 *
 * The threat is specific. An agent asked to make a red gate green can demote a
 * decision to class 4 with a paragraph, or move it back to `proposed` — and the
 * second does not even raise the class-4 count, so the number reported upward as
 * risk stays flat while the rule stops being held.
 */
export const LOCK_FILE = `${PRODUCT_NAME}.lock`;

export interface Ratification {
  status: string;
  class: number | null;
  /** Hash of the `## Decision` section, so an edit to it is visible. */
  decision: string;
}

export interface Lock {
  version: number;
  adrs: Record<string, Ratification>;
}

/** Hash of the operative section — the one the hook delivers and the gate quotes. */
export function decisionHash(record: AdrRecord): string {
  let body = "";
  try {
    body = decisionSection(readFileSync(record.path, "utf8"), Number.MAX_SAFE_INTEGER) ?? "";
  } catch {
    body = "";
  }
  return `sha256:${createHash("sha256").update(body.trim(), "utf8").digest("hex").slice(0, 32)}`;
}

export function ratificationOf(record: AdrRecord): Ratification {
  return {
    status: String(record.status),
    class: typeof record.enforcementClass === "number" ? record.enforcementClass : null,
    decision: decisionHash(record),
  };
}

export function lockPath(root: string): string {
  return join(root, LOCK_FILE);
}

/** Null when the repository keeps no lock — an unguarded ledger, not an error. */
export function readLock(root: string): Lock | null {
  const path = lockPath(root);
  if (!existsSync(path)) return null;
  try {
    const raw = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<Lock>;
    return { version: raw.version ?? 1, adrs: raw.adrs ?? {} };
  } catch {
    // A lock that does not parse cannot say what was ratified. Treating it as
    // absent would silently drop the guarantee; the caller reports it instead.
    return { version: 0, adrs: {} };
  }
}

export function writeLock(root: string, records: AdrRecord[]): Lock {
  const adrs: Record<string, Ratification> = {};
  for (const record of records) {
    if (record.id.length === 0) continue;
    adrs[record.id] = ratificationOf(record);
  }
  const lock: Lock = { version: 1, adrs };
  const header = [
    `# ${LOCK_FILE} — what was ratified.`,
    "#",
    "# Written by `ratify`, which is a human act. The gate fails when a decision",
    "# in here is weakened without this file changing to match: a status moved",
    "# backwards, a class dropped, or a Decision edited. Own this path so that",
    "# updating it needs the architect's approval, or it is a record rather than",
    "# a control.",
    "",
  ].join("\n");
  writeFileSync(lockPath(root), `${header}${stringify(lock)}`, "utf8");
  return lock;
}

/** Lower class number is stronger, so a larger one is a demotion. */
const weaker = (was: number | null, now: number | null): boolean =>
  was !== null && now !== null && now > was;

export interface Weakening {
  id: string;
  message: string;
}

/**
 * Every way the ledger now claims less than what was ratified.
 *
 * Adding a decision, strengthening one, or superseding one properly are all
 * silent here. Only weakening speaks.
 */
export function weakenings(lock: Lock, records: AdrRecord[]): Weakening[] {
  const found: Weakening[] = [];
  const byId = new Map(records.filter((r) => r.id.length > 0).map((r) => [r.id, r]));

  for (const [id, was] of Object.entries(lock.adrs)) {
    const now = byId.get(id);
    if (now === undefined) {
      found.push({
        id,
        message: `${id} was ratified and is no longer in the ledger — supersede a decision, never delete it`,
      });
      continue;
    }

    const nowStatus = String(now.status);
    if (was.status === "accepted" && nowStatus !== "accepted") {
      if (nowStatus === "superseded") {
        const by = records.find((r) => r.supersedes === id);
        if (by === undefined) {
          found.push({
            id,
            message: `${id} is superseded but no decision claims it — set \`supersedes: ${id}\` on the one that replaces it`,
          });
        }
      } else {
        // The quiet one: un-ratifying does not raise the class-4 count, so the
        // number reported upward as risk stays flat while the rule stops being
        // held. It must be the loudest thing this gate says.
        found.push({
          id,
          message: `${id} was ratified and is now \`${nowStatus}\` — a ratified decision is superseded, not un-ratified`,
        });
      }
    }

    if (weaker(was.class, now.enforcementClass ?? null)) {
      found.push({
        id,
        message: `${id} was ratified at class ${was.class} and now claims class ${now.enforcementClass} — demoting a decision is the architect's call, recorded by \`ratify\``,
      });
    }

    const nowDecision = decisionHash(now);
    if (was.status === "accepted" && nowDecision !== was.decision) {
      found.push({
        id,
        message: `${id}'s Decision changed after ratification — amend it deliberately and re-ratify, or supersede it`,
      });
    }
  }

  return found;
}
