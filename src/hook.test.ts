import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { editedText, matchAdrs, hookResponse } from "./hook.js";
import { loadLedger } from "./ledger.js";

function repo(edits?: [string, string]): string {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-hook-"));
  init({ cwd });
  if (edits !== undefined) {
    const path = join(cwd, "harmost.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace(edits[0], edits[1]), "utf8");
  }
  return cwd;
}
const accept = (path: string) =>
  writeFileSync(path, readFileSync(path, "utf8").replace("status: proposed", "status: accepted"), "utf8");

const context = (out: string | null): string =>
  out === null ? "" : (JSON.parse(out).hookSpecificOutput.additionalContext as string);

test("extracts edited text from Edit, Write and MultiEdit", () => {
  assert.match(editedText({ new_string: "alpha" }), /alpha/);
  assert.match(editedText({ content: "beta" }), /beta/);
  assert.match(editedText({ edits: [{ new_string: "gamma" }, { new_string: "delta" }] }), /gamma\n?delta/s);
  assert.equal(editedText(null), "");
  assert.equal(editedText("nonsense"), "");
});

test("is path-blind — the file path is never matched against", () => {
  const cwd = repo();
  accept(newAdr("Sessions go through the choke point", { class: "2", symbols: "create_session", cwd }).path);
  const out = hookResponse(
    { tool_name: "Edit", tool_input: { file_path: "/srv/create_session/index.js", new_string: "const x = 1;" } },
    cwd,
  );
  assert.equal(out, null, "a symbol appearing only in the path must not fire the hook");
});

test("delivers the matching ADR when the edited text contains its symbol", () => {
  const cwd = repo();
  accept(newAdr("Deactivated users must never authenticate", { class: "2", symbols: "create_session,active", cwd }).path);
  const out = hookResponse(
    { tool_name: "Edit", tool_input: { new_string: "return create_session(user);" } },
    cwd,
  );
  assert.ok(out !== null);
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /ADR-001/);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined, "the hook must never decide permissions");
});

test("matching is whole-word", () => {
  const cwd = repo();
  accept(newAdr("Sessions rule", { class: "2", symbols: "create_session", cwd }).path);
  assert.equal(hookResponse({ tool_name: "Edit", tool_input: { new_string: "create_session_v2(u)" } }, cwd), null);
  assert.notEqual(hookResponse({ tool_name: "Edit", tool_input: { new_string: "create_session(u)" } }, cwd), null);
});

test("superseded and rejected decisions are never delivered", () => {
  const cwd = repo();
  const { path } = newAdr("Old rule", { class: "2", symbols: "legacy_login", cwd });
  writeFileSync(path, readFileSync(path, "utf8").replace("status: proposed", "status: superseded"), "utf8");
  assert.equal(hookResponse({ tool_name: "Edit", tool_input: { new_string: "legacy_login()" } }, cwd), null);
});

test("orders most-specific-first and honours the injection cap", () => {
  const cwd = repo(["max_injected_adrs: 3", "max_injected_adrs: 2"]);
  accept(newAdr("One symbol", { class: "2", symbols: "alpha", cwd }).path);
  accept(newAdr("Three symbols", { class: "2", symbols: "alpha,beta,gamma", cwd }).path);
  accept(newAdr("Two symbols", { class: "2", symbols: "alpha,beta", cwd }).path);

  const { records } = loadLedger(join(cwd, "adr"));
  const matches = matchAdrs("alpha beta gamma", records, 2);
  assert.equal(matches.length, 2, "cap respected");
  assert.deepEqual(matches.map((m) => m.hits), [3, 2], "most specific first");
  assert.equal(matches[0]?.record.id, "ADR-002");
});

test("says nothing for a tool that is not configured", () => {
  const cwd = repo();
  accept(newAdr("A rule", { class: "2", symbols: "create_session", cwd }).path);
  assert.equal(hookResponse({ tool_name: "Bash", tool_input: { new_string: "create_session" } }, cwd), null);
});

test("Q2 — endpoints match on the resource segment across differing prefixes", () => {
  const cwd = repo();
  const { path } = newAdr("Asset reads are tenant-scoped", { class: "2", symbols: "assertTenant", cwd });
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("applies-to:", 'endpoints:\n  - "/Assets/findOne"\napplies-to:'),
    "utf8",
  );
  accept(path);
  // mobile's vocabulary, not the backend's — no shared identifier, shared route.
  const out = hookResponse(
    { tool_name: "Edit", tool_input: { new_string: "apiClient.get('/api/v1/Assets/findOne')" } },
    cwd,
  );
  assert.match(context(out), /ADR-001/);
});

test("a malformed event never throws", () => {
  const cwd = repo();
  accept(newAdr("A rule", { class: "2", symbols: "create_session", cwd }).path);
  for (const event of [{}, { tool_name: "Edit" }, { tool_input: null }, { tool_input: { edits: "nope" } }]) {
    assert.doesNotThrow(() => hookResponse(event as never, cwd));
  }
});

test("stays well inside the 200ms budget with 100 ADRs", () => {
  const cwd = repo();
  for (let i = 1; i <= 100; i += 1) {
    accept(newAdr(`Rule number ${i}`, { class: "2", symbols: `symbol_${i}`, cwd }).path);
  }
  const started = Date.now();
  const out = hookResponse({ tool_name: "Edit", tool_input: { new_string: "symbol_57()" } }, cwd);
  const elapsed = Date.now() - started;
  assert.match(context(out), /ADR-057/);
  assert.ok(elapsed < 200, `took ${elapsed}ms`);
});
