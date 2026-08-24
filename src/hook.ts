import { readConfig } from "./config-read.js";
import { loadLedger, type AdrRecord } from "./ledger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic context delivery (CLI spec §7).
 *
 * Two properties matter more than anything this file does:
 *
 *   1. It must NEVER break the agent's edit loop. Every failure path exits 0
 *      and says nothing. A hook that crashes takes the developer's session
 *      with it, and a governance tool that makes people disable the hook has
 *      enforced nothing.
 *   2. It must never block. Blocking is available (`permissionDecision: deny`)
 *      and is deliberately not used: this hook delivers the rule, the merge
 *      gate decides. Steering at write time would relocate attention, not
 *      remove it.
 */

const MATCH_BUDGET_MS = 200;

/** Fields carrying text the agent is about to write. `file_path` is deliberately
 *  excluded — matching the edited text rather than the path is the point,
 *  because path filters rot as code moves. */
export function editedText(toolInput: unknown): string {
  if (toolInput === null || typeof toolInput !== "object") return "";
  const input = toolInput as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ["new_string", "content", "new_source", "prompt"]) {
    const value = input[key];
    if (typeof value === "string") parts.push(value);
  }
  // MultiEdit carries an array of edits.
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object") {
        const value = (edit as Record<string, unknown>).new_string;
        if (typeof value === "string") parts.push(value);
      }
    }
  }
  return parts.join("\n");
}

const wholeWord = (term: string): RegExp =>
  new RegExp(`(?<![\\w$])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);

/** Mount-point noise. Stripped from the ledger's route so a rule reaches a
 *  client whichever side carries the prefix — the swagger-generated list is
 *  full backend paths, while clients often write the bare resource. */
const MOUNT_SEGMENT = /^(api|rest|public|internal|v\d+)$/i;

/** Endpoints are matched on their resource segments: prefixes differ between
 *  clients (`/Assets/findOne` vs `/api/v1/Assets/findOne`) but the resource
 *  does not. Path parameters are skipped — `{id}` names nothing in the code. */
export const endpointNeedles = (endpoint: string): string[] => {
  const segments = endpoint
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("{") && !segment.startsWith(":"));
  let start = 0;
  while (start < segments.length && MOUNT_SEGMENT.test(segments[start]!)) start += 1;
  // Keep at least the last segment: a route that is nothing but mount points
  // has no resource to match on, and must not become a wildcard.
  return start >= segments.length ? [] : segments.slice(start);
};

export interface Match {
  record: AdrRecord;
  hits: number;
}

export function matchAdrs(text: string, records: AdrRecord[], cap: number): Match[] {
  if (text.length === 0) return [];
  const matches: Match[] = [];

  for (const record of records) {
    if (record.status === "superseded" || record.status === "rejected") continue;
    let hits = 0;
    for (const symbol of record.symbols) {
      if (symbol.length > 0 && wholeWord(symbol).test(text)) hits += 1;
    }
    for (const endpoint of record.endpoints) {
      const needles = endpointNeedles(endpoint);
      // `[].every()` is vacuously true: without this guard a degenerate route
      // such as "/" or "/api/v1" would match every edit ever made.
      if (needles.length > 0 && needles.every((n) => wholeWord(n).test(text))) hits += 1;
    }
    if (hits > 0) matches.push({ record, hits });
  }

  // Most specific first: an ADR matching three of its symbols is more likely
  // to be about this edit than one matching a single common identifier.
  matches.sort((a, b) => b.hits - a.hits || a.record.id.localeCompare(b.record.id));
  return matches.slice(0, cap);
}

export function renderContext(matches: Match[]): string {
  const ratified = matches.filter((m) => m.record.status === "accepted").length;
  const draft = matches.length - ratified;

  const header =
    matches.length === 1
      ? "1 architectural decision covers the code you are editing."
      : `${matches.length} architectural decisions cover the code you are editing.`;

  // Say which are binding. Telling an agent a draft "is enforced by the merge
  // gate" is false — `check` deliberately does not gate proposed ADRs — and a
  // delivery mechanism that misstates authority teaches the agent to discount it.
  const authority: string[] = [];
  if (ratified > 0) {
    authority.push(
      `${ratified} ratified — the merge gate enforces ${ratified === 1 ? "it" : "them"}. Read before you write.`,
    );
  }
  if (draft > 0) {
    authority.push(`${draft} still proposed — not yet ratified, and not yet enforced. Treat as a warning.`);
  }

  const bodies = matches.map(({ record }) => {
    let source: string;
    try {
      source = readFileSync(record.path, "utf8");
    } catch {
      source = `${record.id}: ${record.invariant}`;
    }
    const label = record.status === "accepted" ? "RATIFIED" : String(record.status).toUpperCase();
    return `--- ${record.id} [${label}] (${record.file}) ---\n${source.trim()}`;
  });

  return [header, ...authority, "", ...bodies].join("\n");
}

export interface HookEvent {
  tool_name?: string;
  tool_input?: unknown;
}

/** Returns the JSON to print, or null to say nothing at all. */
export function hookResponse(event: HookEvent, cwd: string): string | null {
  const started = Date.now();
  const config = readConfig(cwd);

  if (config.hook.tools.length > 0 && typeof event.tool_name === "string") {
    if (!config.hook.tools.includes(event.tool_name)) return null;
  }

  const text = editedText(event.tool_input);
  if (text.length === 0) return null;

  // Parse errors are dropped rather than surfaced: this process must never
  // break the edit loop. A malformed ADR silently stops being delivered, which
  // is safe only because `check` fails the build on the same file — the gate is
  // what makes the hook's silence recoverable.
  const { records } = loadLedger(join(cwd, config.adrDir));
  // Checked here, where bailing still saves the matching and rendering work.
  // Best-effort only: by definition it cannot bound work already done, so the
  // real bound is the host `timeout` on the registration (see claude-settings).
  if (Date.now() - started > MATCH_BUDGET_MS) return null;

  const matches = matchAdrs(text, records, config.hook.maxInjectedAdrs);
  if (matches.length === 0) return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: renderContext(matches),
    },
  });
}
