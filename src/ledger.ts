import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ADR_FILE } from "./adr.js";

export type Status = "proposed" | "accepted" | "superseded" | "rejected";
export const STATUSES: Status[] = ["proposed", "accepted", "superseded", "rejected"];
export type EnforcementClass = 1 | 2 | 3 | 4;

/** The repo the gate is running in, when the ledger doesn't name repos explicitly. */
export const THIS_REPO = ".";

export interface Artifact {
  type: "test" | "lint";
  file: string;
  name?: string;
}

export interface AdrRecord {
  id: string;
  title: string;
  status: Status;
  enforcementClass: EnforcementClass;
  invariant: string;
  symbols: string[];
  endpoints: string[];
  appliesTo: string[];
  /**
   * Normalised to a map from repo to artifacts. A flat list in the file means
   * "this repo" — a single-repo ledger is the one-key case of the general
   * shape, so nothing downstream has to know which form was written.
   */
  enforcedBy: Record<string, Artifact[]>;
  enforcedByWasMap: boolean;
  supersedes: string | null;
  justification: string | null;
  file: string;
  path: string;
}

export interface LoadError {
  file: string;
  message: string;
}

export interface Ledger {
  records: AdrRecord[];
  errors: LoadError[];
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

function normaliseArtifacts(value: unknown): {
  map: Record<string, Artifact[]>;
  wasMap: boolean;
} {
  if (value === undefined || value === null) return { map: {}, wasMap: false };
  if (Array.isArray(value)) {
    return { map: { [THIS_REPO]: value as Artifact[] }, wasMap: false };
  }
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const map: Record<string, Artifact[]> = {};
    for (const [repo, artifacts] of Object.entries(raw)) {
      map[repo] = Array.isArray(artifacts) ? (artifacts as Artifact[]) : [];
    }
    return { map, wasMap: true };
  }
  return { map: {}, wasMap: false };
}

/** Parse one ADR file. Returns a record, or an error naming the file. */
export function parseAdr(file: string, path: string, source: string): AdrRecord | LoadError {
  const match = FRONTMATTER.exec(source);
  if (!match) return { file, message: "no YAML frontmatter block" };

  let raw: Record<string, unknown>;
  try {
    raw = (parse(match[1]!) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return { file, message: `frontmatter does not parse: ${(error as Error).message}` };
  }

  const { map, wasMap } = normaliseArtifacts(raw["enforced-by"]);
  return {
    id: raw.id === undefined ? "" : String(raw.id),
    title: raw.title === undefined ? "" : String(raw.title),
    status: raw.status as Status,
    enforcementClass: raw["enforcement-class"] as EnforcementClass,
    invariant: raw.invariant === undefined ? "" : String(raw.invariant).trim(),
    symbols: asStringArray(raw.symbols),
    endpoints: asStringArray(raw.endpoints),
    appliesTo: asStringArray(raw["applies-to"]),
    enforcedBy: map,
    enforcedByWasMap: wasMap,
    supersedes: raw.supersedes === undefined || raw.supersedes === null ? null : String(raw.supersedes),
    justification:
      raw.justification === undefined || raw.justification === null ? null : String(raw.justification),
    file,
    path,
  };
}

/** The configured ledger directory is absent. Distinct from an empty ledger:
 *  an empty ledger is a healthy starting state, a missing one is a broken
 *  config, and reporting them identically lets one typo in `adr_dir` turn the
 *  merge gate permanently green over every accepted ADR in the repo. */
export class MissingLedgerError extends Error {
  constructor(adrDirPath: string) {
    super(`adr_dir "${adrDirPath}" does not exist — the ledger is missing, not empty`);
    this.name = "MissingLedgerError";
  }
}

/** Case-insensitive: a ledger written on a case-insensitive filesystem can
 *  hold ADR-001-x.MD, and silently skipping it takes the gate green over an
 *  ADR nobody can see. */
const isMarkdown = (file: string): boolean => file.toLowerCase().endsWith(".md");
const isTemplate = (file: string): boolean => file.toLowerCase() === "template.md";

export function loadLedger(adrDirPath: string): Ledger {
  if (!existsSync(adrDirPath)) throw new MissingLedgerError(adrDirPath);
  const records: AdrRecord[] = [];
  const errors: LoadError[] = [];

  for (const file of readdirSync(adrDirPath).sort()) {
    if (!isMarkdown(file) || isTemplate(file)) continue;
    if (!ADR_FILE.test(file)) {
      errors.push({ file, message: "filename must be ADR-<NNN>-<kebab-slug>.md" });
      continue;
    }
    const path = join(adrDirPath, file);
    const parsed = parseAdr(file, path, readFileSync(path, "utf8"));
    if ("message" in parsed) errors.push(parsed);
    else records.push(parsed);
  }
  return { records, errors };
}
