import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { init } from "./init.js";
import { newAdr } from "./new.js";
import { briefText, gateFailure } from "./brief.js";
import { payloadCwd, sessionRoots, subjectName } from "./session.js";

function repo(prefix = "harmost-brief-"): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  init({ cwd });
  return cwd;
}
const accept = (path: string) =>
  writeFileSync(path, readFileSync(path, "utf8").replace("status: proposed", "status: accepted"), "utf8");

/** An accepted decision with nothing in `enforced-by` — a red wall, by hand. */
function red(cwd: string, title: string): void {
  accept(newAdr(title, { class: "2", symbols: "create_session", cwd }).path);
}

function declare(cwd: string, ...dirs: string[]): void {
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify({ permissions: { additionalDirectories: dirs } }, null, 2),
    "utf8",
  );
}

test("the brief names the repository it speaks for", () => {
  const cwd = repo();
  red(cwd, "Sessions go through the choke point");
  const text = briefText([cwd]);
  assert.ok(text !== null);
  assert.ok(text.includes(basename(cwd)), "the repository's name must appear");
  assert.ok(text.includes(cwd), "the path must appear — a name alone is ambiguous across checkouts");
});

test("no verdict may say `this repository` — the reader cannot resolve it", () => {
  const green = repo();
  const dirty = repo();
  red(dirty, "Sessions go through the choke point");
  for (const text of [briefText([green]), briefText([dirty]), briefText([green, dirty]), gateFailure([dirty])]) {
    if (text === null) continue;
    assert.doesNotMatch(text, /this repo/i, `unqualified subject in: ${text}`);
  }
});

test("a ledger's own `repo:` name is what it is called", () => {
  const cwd = repo();
  appendFileSync(join(cwd, "harmost.yaml"), "\nrepo: busmanlauncher\n", "utf8");
  red(cwd, "Every window is constructed with an assistant");
  assert.equal(subjectName(cwd), "busmanlauncher");
  assert.match(briefText([cwd]) ?? "", /busmanlauncher/);
});

test("a green cwd does not make the session green: the second ledger is read, named and reported red", () => {
  const green = repo("harmost-green-");
  const dirty = repo("harmost-dirty-");
  newAdr("Panels derive their tools from the host", { class: "3", symbols: "chatTools", cwd: green });
  red(dirty, "Sessions go through the choke point");
  declare(green, dirty);

  const roots = sessionRoots(green);
  assert.deepEqual(roots, [green, dirty], "cwd first, then what the session declares");

  const text = briefText(roots);
  assert.ok(text !== null);
  assert.ok(text.includes(dirty), "the red repository must be named");
  assert.ok(text.includes(green), "the green one must be named too, not implied");
  assert.match(text, /ADR-001/, "the outstanding decision must be delivered");
  assert.doesNotMatch(text.split("\n")[0], /all held/, "the headline must not report the session green");
});

test("the gate is red when any ledger the session declares is red, and says which", () => {
  const green = repo("harmost-green-");
  const dirty = repo("harmost-dirty-");
  red(dirty, "Sessions go through the choke point");
  declare(green, dirty);

  assert.equal(gateFailure([green]), null, "cwd alone is green — this is the bug being fixed");
  const reason = gateFailure(sessionRoots(green));
  assert.ok(reason !== null, "a red ledger in the session must stop the turn");
  assert.ok(reason.includes(dirty), "the reason must name the repository that is red");
  assert.match(reason, /gate is red in/);
});

test("both ledgers red: the count is reported, and both are named", () => {
  const one = repo("harmost-one-");
  const two = repo("harmost-two-");
  red(one, "Sessions go through the choke point");
  red(two, "Every window is constructed with an assistant");
  declare(one, two);

  const reason = gateFailure(sessionRoots(one));
  assert.ok(reason !== null);
  assert.match(reason, /red in 2 repositories/);
  assert.ok(reason.includes(one) && reason.includes(two));
});

test("a declared directory that is not a ledger is not a subject", () => {
  const cwd = repo();
  const plain = mkdtempSync(join(tmpdir(), "harmost-plain-"));
  declare(cwd, plain, join(cwd, "does-not-exist"));
  assert.deepEqual(sessionRoots(cwd), [cwd], "only directories with a config are spoken about");
});

test("the payload's cwd is authoritative, and an unusable payload is not fatal", () => {
  const cwd = repo();
  assert.equal(payloadCwd(JSON.stringify({ hook_event_name: "SessionStart", cwd })), cwd);
  assert.equal(payloadCwd(""), null);
  assert.equal(payloadCwd("not json"), null);
  assert.equal(payloadCwd(JSON.stringify({ cwd: "/no/such/directory/here" })), null);
  assert.equal(payloadCwd(JSON.stringify({ session_id: "x" })), null);
});

test("silence where the tool was never installed", () => {
  const plain = mkdtempSync(join(tmpdir(), "harmost-plain-"));
  assert.equal(briefText(sessionRoots(plain)), null);
  assert.equal(gateFailure(sessionRoots(plain)), null);
});
