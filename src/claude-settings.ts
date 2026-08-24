import { HOOK_TOOLS } from "./config.js";
import { INVOCATION } from "./name.js";

export const HOOK_COMMAND = `${INVOCATION} hook`;

/**
 * Seconds. The host kills the hook at this point and proceeds with the tool
 * call — so this is the only real bound on how long the hook can stall an
 * edit. Claude Code's default for command hooks is 600s, which is ten minutes
 * inside a developer's edit loop. Our own budget check is self-policing and
 * therefore class 4; this is enforced by the host and cannot be ignored.
 */
export const HOOK_TIMEOUT_SECONDS = 5;

/** Pipe form is accepted by every Claude Code version; comma form needs v2.1.191+. */
export const matcherFor = (tools: readonly string[]): string =>
  (tools.length > 0 ? tools : HOOK_TOOLS).join("|");

/** Default matcher, for callers with no config in hand. */
export const HOOK_MATCHER = matcherFor(HOOK_TOOLS);

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
export interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export type MergeOutcome =
  | { status: "merged"; settings: ClaudeSettings }
  | { status: "unchanged" }
  | { status: "refused"; reason: string };

const isGroup = (value: unknown): value is MatcherGroup =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Merge our PreToolUse registration into an existing settings.json.
 *
 * This file belongs to the user and routinely holds permissions, env and other
 * people's hooks. Three rules follow, and the third is the one that matters:
 *
 *   1. Unrelated keys survive untouched.
 *   2. Running twice changes nothing — a duplicate registration would fire the
 *      hook twice per edit.
 *   3. **Anything we do not recognise, we refuse rather than rewrite.** A
 *      previous version coerced non-canonical shapes through spread and array
 *      operations, so `{"hooks":{"PreToolUse":"guard.sh"}}` was written back as
 *      `["g","u","a","r","d",...]` — silently destroying a working hook. When
 *      the shape is not what we understand, the only safe act is to leave the
 *      file alone and say so.
 */
export function mergeHookRegistration(
  existing: ClaudeSettings,
  tools: readonly string[] = HOOK_TOOLS,
): MergeOutcome {
  const hooksValue = existing.hooks;
  if (hooksValue !== undefined && !isGroup(hooksValue)) {
    return { status: "refused", reason: "`hooks` is not an object" };
  }
  const hooks = { ...((hooksValue ?? {}) as Record<string, unknown>) };

  const preValue = hooks.PreToolUse;
  if (preValue !== undefined && !Array.isArray(preValue)) {
    return { status: "refused", reason: "`hooks.PreToolUse` is not an array" };
  }
  const preToolUse = [...((preValue ?? []) as unknown[])];

  for (const group of preToolUse) {
    if (!isGroup(group)) {
      return { status: "refused", reason: "an entry in `hooks.PreToolUse` is not an object" };
    }
    if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
      return { status: "refused", reason: "a `hooks` list inside `hooks.PreToolUse` is not an array" };
    }
    const already = (group.hooks ?? []).some(
      (h) => isGroup(h) && (h as HookEntry).command === HOOK_COMMAND,
    );
    if (already) return { status: "unchanged" };
  }

  const entry: HookEntry = { type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS };
  const matcher = matcherFor(tools);
  const index = preToolUse.findIndex((g) => isGroup(g) && g.matcher === matcher);

  if (index >= 0) {
    const group = preToolUse[index] as MatcherGroup;
    preToolUse[index] = { ...group, hooks: [...((group.hooks ?? []) as HookEntry[]), entry] };
  } else {
    preToolUse.push({ matcher, hooks: [entry] });
  }

  hooks.PreToolUse = preToolUse;
  return { status: "merged", settings: { ...existing, hooks } };
}
