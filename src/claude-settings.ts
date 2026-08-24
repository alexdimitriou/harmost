import { HOOK_TOOLS } from "./config.js";
import { INVOCATION } from "./name.js";

/** Pipe form is accepted by every Claude Code version; comma form needs v2.1.191+. */
export const HOOK_MATCHER = HOOK_TOOLS.join("|");
export const HOOK_COMMAND = `${INVOCATION} hook`;

interface HookEntry {
  type: string;
  command: string;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
export interface ClaudeSettings {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

/**
 * Merge our PreToolUse registration into an existing settings.json.
 *
 * Three properties this must hold, all of them tested:
 *   1. Unrelated keys survive untouched — this file is the user's, not ours.
 *   2. Other people's hooks survive, including other PreToolUse matchers.
 *   3. Running it twice changes nothing. `init` is re-runnable (CLI spec §5),
 *      so a duplicate registration would mean the hook fires twice per edit.
 *
 * Returns the merged object and whether anything actually changed.
 */
export function mergeHookRegistration(
  existing: ClaudeSettings,
): { settings: ClaudeSettings; changed: boolean } {
  const settings: ClaudeSettings = { ...existing };
  const hooks = { ...(settings.hooks ?? {}) };
  const preToolUse: MatcherGroup[] = [...(hooks.PreToolUse ?? [])];

  // Already registered anywhere under PreToolUse? Then we are done — regardless
  // of which matcher group it sits under, the hook will fire.
  const alreadyRegistered = preToolUse.some((group) =>
    (group.hooks ?? []).some((h) => h.command === HOOK_COMMAND),
  );
  if (alreadyRegistered) return { settings: existing, changed: false };

  const entry: HookEntry = { type: "command", command: HOOK_COMMAND };
  const sameMatcher = preToolUse.findIndex((g) => g.matcher === HOOK_MATCHER);

  if (sameMatcher >= 0) {
    const group = preToolUse[sameMatcher]!;
    preToolUse[sameMatcher] = { ...group, hooks: [...(group.hooks ?? []), entry] };
  } else {
    preToolUse.push({ matcher: HOOK_MATCHER, hooks: [entry] });
  }

  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;
  return { settings, changed: true };
}
