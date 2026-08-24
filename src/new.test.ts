import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { nextId, slugify, parseClass, parseSymbols, formatId } from "./adr.js";
import { NotInitialisedError } from "./config-read.js";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-new-"));
  init({ cwd });
  return cwd;
}
const frontmatter = (path: string) =>
  parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"))![1]!) as Record<string, unknown>;

test("creates ADR-001 with the frontmatter the gate requires", () => {
  const cwd = repo();
  const result = newAdr("Deactivated users must never authenticate", {
    class: "2",
    symbols: "create_session,active,sso_callback",
    cwd,
    today: "2026-08-24",
  });
  assert.equal(result.id, "ADR-001");
  assert.ok(result.path.endsWith("ADR-001-deactivated-users-must-never-authenticate.md"));

  const fm = frontmatter(result.path);
  assert.equal(fm.id, "ADR-001");
  assert.equal(fm.status, "proposed");
  assert.equal(fm["enforcement-class"], 2);
  assert.equal(fm.date, "2026-08-24");
  assert.deepEqual(fm.symbols, ["create_session", "active", "sso_callback"]);
  assert.deepEqual(fm["enforced-by"], []);
});

test("keeps the template's prose sections", () => {
  const cwd = repo();
  const { path } = newAdr("Sessions issue through one choke point", { cwd });
  const body = readFileSync(path, "utf8");
  for (const heading of ["## Context", "## Decision", "## Enforcement"]) {
    assert.ok(body.includes(heading), `missing ${heading}`);
  }
  assert.ok(body.includes("why is this NOT class 1?"));
});

test("allocates the next id and never reuses one", () => {
  const cwd = repo();
  assert.equal(newAdr("first rule", { cwd }).id, "ADR-001");
  assert.equal(newAdr("second rule", { cwd }).id, "ADR-002");
  assert.equal(newAdr("third rule", { cwd }).id, "ADR-003");
  assert.equal(readdirSync(join(cwd, "adr")).filter((f) => f.startsWith("ADR-")).length, 3);
});

test("an omitted class is 4, not a flattering default", () => {
  const cwd = repo();
  const { path, enforcementClass } = newAdr("some rule nobody has thought about", { cwd });
  assert.equal(enforcementClass, 4);
  assert.equal(frontmatter(path)["enforcement-class"], 4);
});

test("rejects an out-of-range class", () => {
  assert.throws(() => parseClass("0"), /must be 1, 2, 3 or 4/);
  assert.throws(() => parseClass("5"), /must be 1, 2, 3 or 4/);
  assert.throws(() => parseClass("two"), /must be 1, 2, 3 or 4/);
});

test("refuses to run in a repo that was never initialised", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-bare-"));
  assert.throws(() => newAdr("a rule", { cwd }), NotInitialisedError);
});

test("allocation ignores files that are not ADRs", () => {
  const cwd = repo();
  writeFileSync(join(cwd, "adr", "notes.md"), "scratch\n", "utf8");
  writeFileSync(join(cwd, "adr", "ADR-draft.md"), "malformed\n", "utf8");
  assert.equal(newAdr("a rule", { cwd }).id, "ADR-001");
});

test("the same title twice yields two decisions, neither overwritten", () => {
  const cwd = repo();
  const first = newAdr("a rule", { cwd });
  writeFileSync(first.path, "hand-edited\n", "utf8");
  const second = newAdr("a rule", { cwd });
  assert.equal(first.id, "ADR-001");
  assert.equal(second.id, "ADR-002");
  assert.notEqual(first.path, second.path);
  assert.equal(readFileSync(first.path, "utf8"), "hand-edited\n");
});

test("nextId skips gaps rather than reusing a retired id", () => {
  const cwd = repo();
  writeFileSync(join(cwd, "adr", "ADR-007-old.md"), "---\nid: ADR-007\n---\n", "utf8");
  assert.equal(nextId(join(cwd, "adr")), 8);
});

test("titles with colons and punctuation stay valid YAML", () => {
  const cwd = repo();
  const title = 'Auth: "deactivated" users — never, ever authenticate';
  const { path } = newAdr(title, { cwd });
  assert.equal(frontmatter(path).title, title);
});

test("honours a custom adr_dir from the config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "harmost-cfg-"));
  writeFileSync(join(cwd, "harmost.yaml"), "version: 1\nadr_dir: decisions\n", "utf8");
  const { path } = newAdr("a rule", { cwd });
  assert.ok(path.includes(`${"decisions"}/ADR-001`), path);
});

test("slug and id helpers", () => {
  assert.equal(slugify("Deactivated Users MUST never authenticate!"), "deactivated-users-must-never-authenticate");
  assert.equal(slugify("   "), "untitled");
  assert.equal(formatId(7), "ADR-007");
  assert.equal(formatId(1234), "ADR-1234");
  assert.deepEqual(parseSymbols(" a , b ,, c "), ["a", "b", "c"]);
  assert.deepEqual(parseSymbols(undefined), []);
});
