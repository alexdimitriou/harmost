import { HOOK_TOOLS } from "./config.js";
import { INVOCATION } from "./name.js";

export const HOOK_COMMAND = `${INVOCATION} hook`;
export const BRIEF_COMMAND = `${INVOCATION} brief`;
export const GATE_COMMAND = `${INVOCATION} gate`;

/** Seconds. Both read the ledger and evaluate rules, so they need more than the
 *  edit hook, and neither sits inside the keystroke loop. */
export const SESSION_TIMEOUT_SECONDS = 20;

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
  let editHookPresent = false;
  let added = false;

  for (const group of preToolUse) {
    if (!isGroup(group)) {
      return { status: "refused", reason: "an entry in `hooks.PreToolUse` is not an object" };
    }
    if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
      return { status: "refused", reason: "a `hooks` list inside `hooks.PreToolUse` is not an array" };
    }
    if ((group.hooks ?? []).some((h) => isGroup(h) && (h as HookEntry).command === HOOK_COMMAND)) {
      editHookPresent = true;
    }
  }

  // Not an early return. A repository initialised by an earlier version already
  // has the edit hook, and returning here would leave the session events
  // unregistered for exactly the repositories that have been using this longest.
  if (!editHookPresent) {
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
    added = true;
  }

  // SessionStart and Stop take no matcher — verified against a live config, not
  // inferred. A registration in a shape the host does not read fires never, and
  // a delivery mechanism that silently does nothing is the failure this whole
  // tool is about.
  for (const [event, command] of [
    ["SessionStart", BRIEF_COMMAND],
    ["Stop", GATE_COMMAND],
  ] as const) {
    const value = hooks[event];
    if (value !== undefined && !Array.isArray(value)) {
      return { status: "refused", reason: `\`hooks.${event}\` is not an array` };
    }
    const groups = [...((value ?? []) as unknown[])];
    let present = false;
    for (const group of groups) {
      if (!isGroup(group)) {
        return { status: "refused", reason: `an entry in \`hooks.${event}\` is not an object` };
      }
      if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
        return { status: "refused", reason: `a \`hooks\` list inside \`hooks.${event}\` is not an array` };
      }
      if ((group.hooks ?? []).some((h) => isGroup(h) && (h as HookEntry).command === command)) {
        present = true;
      }
    }
    if (!present) {
      groups.push({
        hooks: [{ type: "command", command, timeout: SESSION_TIMEOUT_SECONDS }],
      });
      hooks[event] = groups;
      added = true;
    }
  }

  if (!added) return { status: "unchanged" };
  return { status: "merged", settings: { ...existing, hooks } };
}
