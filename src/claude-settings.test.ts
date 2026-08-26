import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeHookRegistration,
  matcherFor,
  HOOK_COMMAND,
  HOOK_MATCHER,
  HOOK_TIMEOUT_SECONDS,
  type ClaudeSettings,
} from "./claude-settings.js";

const merged = (input: ClaudeSettings): ClaudeSettings => {
  const outcome = mergeHookRegistration(input);
  assert.equal(outcome.status, "merged", `expected merge, got ${outcome.status}`);
  return (outcome as { status: "merged"; settings: ClaudeSettings }).settings;
};
const commandsIn = (s: ClaudeSettings): string[] =>
  ((s.hooks?.PreToolUse ?? []) as { hooks?: { command: string }[] }[]).flatMap((g) =>
    (g.hooks ?? []).map((h) => h.command),
  );

test("registers into an empty settings file", () => {
  assert.deepEqual(merged({}).hooks?.PreToolUse, [
    { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }] },
  ]);
});

test("registers a host timeout — the only real bound on stalling an edit", () => {
  const entry = ((merged({}).hooks?.PreToolUse ?? []) as { hooks: { timeout: number }[] }[])[0]!.hooks[0]!;
  assert.equal(entry.timeout, HOOK_TIMEOUT_SECONDS);
  assert.ok(HOOK_TIMEOUT_SECONDS < 600, "must be far below Claude Code's 600s default");
});

test("is idempotent — running init twice registers the hook once", () => {
  const first = merged({});
  const second = mergeHookRegistration(first);
  assert.equal(second.status, "unchanged");
  assert.equal(commandsIn(first).filter((c) => c === HOOK_COMMAND).length, 1);
});

test("never clobbers unrelated keys", () => {
  const settings = merged({ permissions: { allow: ["Bash(npm test)"] }, env: { FOO: "bar" } });
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.deepEqual(settings.env, { FOO: "bar" });
});

test("preserves somebody else's PreToolUse hooks", () => {
  const theirs = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "tdd-guard" }] }],
      PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier" }] }],
    },
  };
  const settings = merged(theirs);
  assert.ok(commandsIn(settings).includes("tdd-guard"));
  assert.ok(commandsIn(settings).includes(HOOK_COMMAND));
  assert.deepEqual(settings.hooks?.PostToolUse, theirs.hooks.PostToolUse);
});

test("joins an existing group with our matcher rather than duplicating it", () => {
  const settings = merged({
    hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "other" }] }] },
  });
  assert.equal((settings.hooks?.PreToolUse as unknown[]).length, 1);
  assert.deepEqual(commandsIn(settings), ["other", HOOK_COMMAND]);
});

test("detects prior registration under a different matcher and does not duplicate it", () => {
  // A second edit-hook entry fires the hook twice per edit. The session events
  // are still added: a repository initialised by an earlier version is exactly
  // the one that would otherwise never get them.
  const outcome = mergeHookRegistration({
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
  });
  assert.equal(outcome.status, "merged");

  const settings = (outcome as { settings: ClaudeSettings }).settings;
  const pre = (settings.hooks as Record<string, unknown>).PreToolUse as { hooks?: unknown[] }[];
  const edits = pre.flatMap((g) => g.hooks ?? []).filter(
    (h) => (h as { command?: string }).command === HOOK_COMMAND,
  );
  assert.equal(edits.length, 1, "the edit hook must appear exactly once");
});

test("registers the session events, and running twice adds nothing", () => {
  const first = mergeHookRegistration({});
  assert.equal(first.status, "merged");
  const settings = (first as { settings: ClaudeSettings }).settings;
  const hooks = settings.hooks as Record<string, unknown>;

  for (const event of ["SessionStart", "Stop"]) {
    const groups = hooks[event] as { matcher?: string; hooks?: unknown[] }[];
    assert.ok(Array.isArray(groups) && groups.length === 1, `${event} must be registered`);
    // Neither event takes a matcher. A registration in a shape the host does
    // not read fires never, which is the failure this tool exists to prevent.
    assert.equal(groups[0]?.matcher, undefined, `${event} must carry no matcher`);
  }

  assert.equal(mergeHookRegistration(settings).status, "unchanged");
});

test("REFUSES to rewrite shapes it does not understand, rather than mangling them", () => {
  // The prior implementation spread a string into ["g","u","a","r","d",...],
  // silently destroying a working hook registration.
  for (const [label, input] of [
    ["PreToolUse as a string", { hooks: { PreToolUse: "guard.sh" } }],
    ["PreToolUse as an object", { hooks: { PreToolUse: {} } }],
    ["hooks as a string", { hooks: "echo hi" }],
    ["a group that is a string", { hooks: { PreToolUse: ["guard.sh"] } }],
    ["a group whose hooks is a string", { hooks: { PreToolUse: [{ matcher: "Edit", hooks: "x" }] } }],
  ] as [string, ClaudeSettings][]) {
    const outcome = mergeHookRegistration(input);
    assert.equal(outcome.status, "refused", `${label} must be refused, not rewritten`);
    assert.ok((outcome as { reason: string }).reason.length > 0);
  }
});

test("the matcher follows configured tools", () => {
  assert.equal(matcherFor(["Edit", "NotebookEdit"]), "Edit|NotebookEdit");
  assert.equal(matcherFor([]), HOOK_MATCHER, "empty config falls back to the defaults");
});
