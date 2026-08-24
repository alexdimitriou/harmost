import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHookRegistration, HOOK_COMMAND, HOOK_MATCHER } from "./claude-settings.js";

const commandsIn = (s: ReturnType<typeof mergeHookRegistration>["settings"]) =>
  (s.hooks?.PreToolUse ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));

test("registers into an empty settings file", () => {
  const { settings, changed } = mergeHookRegistration({});
  assert.equal(changed, true);
  assert.deepEqual(settings.hooks?.PreToolUse, [
    { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: HOOK_COMMAND }] },
  ]);
});

test("is idempotent — running init twice registers the hook once", () => {
  const first = mergeHookRegistration({});
  const second = mergeHookRegistration(first.settings);
  assert.equal(second.changed, false);
  assert.equal(commandsIn(second.settings).filter((c) => c === HOOK_COMMAND).length, 1);
  assert.deepEqual(second.settings, first.settings);
});

test("never clobbers unrelated keys", () => {
  const { settings } = mergeHookRegistration({
    permissions: { allow: ["Bash(npm test)"] },
    env: { FOO: "bar" },
  });
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
  const { settings } = mergeHookRegistration(theirs);
  assert.ok(commandsIn(settings).includes("tdd-guard"));
  assert.ok(commandsIn(settings).includes(HOOK_COMMAND));
  assert.deepEqual(settings.hooks?.PostToolUse, theirs.hooks.PostToolUse);
});

test("joins an existing group with our matcher rather than duplicating it", () => {
  const { settings } = mergeHookRegistration({
    hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "other" }] }] },
  });
  assert.equal(settings.hooks?.PreToolUse?.length, 1);
  assert.deepEqual(commandsIn(settings), ["other", HOOK_COMMAND]);
});

test("detects prior registration under a different matcher and does nothing", () => {
  const { changed } = mergeHookRegistration({
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
  });
  assert.equal(changed, false);
});
