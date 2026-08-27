import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CONFIG_FILE } from "./name.js";
import { readConfig } from "./config-read.js";

/**
 * Who the session's delivery is speaking about.
 *
 * `brief` and `gate` fire once per session, not once per repository, and the
 * host hands them a single `cwd`. Everything they said was therefore about
 * whichever directory the host happened to start in — and they said it without
 * ever naming it. In a session holding two repositories that is not silence
 * about the second one, it is confidence about an unnamed subject: a green
 * verdict that reads as the session's when it is one repository's.
 *
 * Two rules follow, and the first is the one that survives a host that gives
 * us nothing extra:
 *
 *   1. Every verdict names the repository it is about. No output may say
 *      "this repository" — the reader cannot resolve it, and neither could we.
 *   2. We speak only about ledgers we actually read. The discovery below is
 *      best effort by construction (see `sessionRoots`), so the set is never
 *      claimed to be the session's — only listed.
 */
export interface Subject {
  root: string;
  /** The ledger's own `repo:` name, else the directory's. */
  name: string;
}

/** The `cwd` the host says the session is in, or null if it did not say. */
export function payloadCwd(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = (JSON.parse(trimmed) as { cwd?: unknown }).cwd;
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return existsSync(value) ? resolve(value) : null;
  } catch {
    // A payload we cannot parse is not a reason to say nothing: the caller
    // falls back to the process's own cwd, which is what we used to use for
    // everything.
    return null;
  }
}

const expand = (value: string, base: string): string =>
  value.startsWith("~/") ? join(homedir(), value.slice(2)) : isAbsolute(value) ? value : resolve(base, value);

function declaredDirs(settingsPath: string, base: string): string[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions?: { additionalDirectories?: unknown };
    };
    const list = raw.permissions?.additionalDirectories;
    if (!Array.isArray(list)) return [];
    return list.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => expand(v, base));
  } catch {
    // Someone else's file, in a shape we do not understand. Read nothing from
    // it rather than guess.
    return [];
  }
}

/**
 * Ledgers this session can be shown to hold — cwd first.
 *
 * Best effort, and knowingly incomplete. The host's hook payload carries
 * `session_id`, `transcript_path` and `cwd` and no list of working
 * directories, and a directory added at launch (`--add-dir`, the SDK's
 * `additionalDirectories`, an editor's multi-root workspace) leaves no trace
 * on disk to read. What can be read is the settings a repository declares, so
 * that is what is read.
 *
 * This is why rule 1 above is the load-bearing half: a set that cannot be
 * complete must never be presented as the session's, and output that names its
 * subject makes no claim about repositories it never saw.
 */
export function sessionRoots(cwd: string): string[] {
  const start = resolve(cwd);
  const candidates = [
    start,
    ...declaredDirs(join(start, ".claude", "settings.json"), start),
    ...declaredDirs(join(start, ".claude", "settings.local.json"), start),
    ...declaredDirs(join(homedir(), ".claude", "settings.json"), homedir()),
  ];

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    const root = resolve(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    // A directory without a config is not a ledger; the session is full of
    // directories, and speaking about the ones that never opted in is the
    // noise that gets a hook switched off.
    if (existsSync(join(root, CONFIG_FILE))) roots.push(root);
  }
  return roots;
}

/** What to call a repository in output. Never "this repository". */
export function subjectName(root: string): string {
  try {
    const named = readConfig(root).repo;
    if (named !== undefined && named.trim().length > 0) return named.trim();
  } catch {
    // Fall through: an unreadable config still has a directory name, and a
    // subject named by its path is infinitely better than an unnamed one.
  }
  return basename(resolve(root));
}

/** `name (/absolute/path)` — the name alone is ambiguous across checkouts. */
export const subjectLabel = (subject: Subject): string => `${subject.name} (${subject.root})`;
