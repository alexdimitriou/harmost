# harmost

**Your review burden shouldn't scale with your agents' output. It should scale with your *decisions* — and decay as your system matures.**

Diff review scales with how much code an agent writes. That is a treadmill: the faster the agent, the more there is to read, and making the reading easier doesn't remove the treadmill. Reviewing *decisions* scales with something else — the rate at which genuinely new architectural rules enter the system — and that rate falls as a domain matures. Six months in, most agent work lands under rules a human already ratified once, and needs no human at all.

`harmost` is the machinery that makes that true: an **ADR ledger in git**, a **coverage gate in CI**, and **deterministic context delivery** to the coding agent.

> **v0.1.0 — `init`, `new`, `check` and `hook` all work.** Single repo, Claude Code
> adapter. Multi-repo verification, mining and the dashboard are roadmap, not stubs.

---

## The problem

Delegating to an opaque implementer converts an architect's *knowns* into *known unknowns*.

"Deactivated users must never authenticate" is a known to an architect — it fires unprompted on reading the user model. An LLM reads code to satisfice: *what do I need to finish this task?* — not *what does this field imply?* So the rule gets enforced on the password path and silently skipped on the SSO path, and nobody finds out until someone tests by hand.

Documentation doesn't fix this. Neither do agent instruction files. They encode only what is already enumerated, and retrieval is probabilistic: they raise first-pass quality and **guarantee nothing**.

The resolution pattern, at every layer: every *"how do I trust the agent to X?"* becomes *"restructure so trust isn't required."*

| Trust question | Restructuring |
|---|---|
| Did it implement the invariant? | Invariant tests at the merge gate |
| Does it know the invariant? | An ADR ledger routed around the agent |
| Did it read the ADR? | A hook injects it deterministically |
| Is this file in scope? | Scope derived from code structure, not a maintained list |

## Enforcement classes

Every invariant declares how strongly it is held. **Default question: why is this NOT class 1?**

| Class | Mechanism | Guarantee |
|---|---|---|
| **1 — Structural** | Choke point, type system, DB constraint, capability gating | Violation impossible by construction |
| **2 — Tested** | Invariant, matrix or property tests | Violation fails CI |
| **3 — Static** | Lint, semgrep, import rules, AST checks | Violation fails CI without running code |
| **4 — Review-only** | Human judgment, sampled | **None.** Permitted only with written justification of why 1–3 are impossible |

An ADR is `accepted` only when its enforcement artifact exists and is named in its frontmatter. Enumerated-but-unenforced is a visible, queryable state — never silence. `check` prints the **class-4 count** as its headline number: the invariants nothing but attention is holding.

## The gate

Most tools block when they find a violation. `harmost` also blocks when a rule a change touches **has no enforcement behind it at all**. That is the inversion: coverage, not luck.

## The agent is told, and cannot finish red

`init --claude` registers three hooks, not one.

| Event | Command | What it does |
|---|---|---|
| `PreToolUse` | `harmost hook` | injects the decisions an edit reaches, as it is made |
| `SessionStart` | `harmost brief` | states what the ledger demands, before anything is edited |
| `Stop` | `harmost gate` | refuses to let a turn finish while the gate is red |

The edit hook is reactive: it fires when an edit matches a decision's symbols, so
an agent that has not touched the covered code does not know the decision exists.
And nothing stopped an agent reporting itself finished with a ratified decision
unheld. Between those two the human was the transport layer — reading the gate
and restating it in a prompt, which is the instruction-file failure this tool
exists to replace.

`harmost gate` is not a new authority. It is the same verdict the merge gate
gives, delivered when the agent believes it is finished rather than after a human
has read its summary. It honours the host's `stop_hook_active`, so it forces one
continuation rather than trapping a session, and it stays silent in a repository
that has no ledger.

Both refuse to weaken anything on the way past:

> Making the gate green means doing what these decisions require, and recording
> the artifact that holds each one in its `enforced-by`. It does not mean
> lowering an enforcement class, moving a decision back to `proposed`, rewording
> what was ratified, or deleting it. If you believe a decision is wrong, say so
> and leave the gate red.

**This is the adapter layer, and it is Claude Code-specific.** A repository whose
agent is something else gets none of it, which is why the CI gate stays the
floor: it does not care what wrote the code.

## Ratification — who may weaken a rule

A gate cannot defend itself. The ledger and this tool's config are files in the
repository being changed, so any rule its author may edit is not a rule that
holds against that author. That matters most when the author is an agent asked
to turn a red gate green: it can demote a decision to class 4 with a paragraph,
or move it back to `proposed` — and **the second does not raise the class-4
count**, so the number reported upward as risk stays flat while the rule stops
being held.

```bash
npx harmost ratify     # record what is ratified, in harmost.lock
```

From then on `check` fails when the ledger claims less than what was ratified:

| Change | What the gate says |
|---|---|
| `accepted` → `proposed` | a ratified decision is superseded, not un-ratified |
| class 3 → class 4 | demoting is the architect's call, recorded by `ratify` |
| the `## Decision` reworded | amend it deliberately and re-ratify, or supersede it |
| the file deleted | supersede a decision, never delete it |
| `superseded` with nothing claiming it | set `supersedes:` on the decision that replaces it |

Adding a decision, strengthening one, or superseding one properly are all
silent. Only weakening speaks.

**`ratify` is the escape hatch, and that is the design.** Weakening is not
impossible — it is an *act*, in a diff, with a name on it. What makes that act
need someone else's agreement is ownership of the path: `init --ci github`
writes a `CODEOWNERS` covering `adr/`, `harmost.lock` and `harmost.yaml`.
Without an owner the lock is a record; with one it is a control.

## The operating rule — the ratchet

**Any bug that reaches manual testing merges only alongside its ADR and its enforcement.**

Not a fixed diff — a fixed diff makes today's pull request safe. The ADR makes the known permanent, and the gate holds it forever after. The known-set grows monotonically and never decays, which is why the human layer shrinks over time instead of growing: each act of ratification retires a whole class of future review.

## Quickstart

```bash
npx harmost init --claude --ci github     # ledger, config, agent hook, CI gate
npx harmost new "Deactivated users must never authenticate" \
    --class 2 --symbols create_session,active,sso_callback
npx harmost check                          # the gate — exit 1 if a rule lacks enforcement
```

Point the new ADR's `enforced-by` at a test that doesn't exist yet and `check` fails by name. Write the test and it passes. Then edit any code containing `create_session` and the hook puts the rule in front of the agent before it writes a line — because the host was told to deliver it, not because the agent remembered to look.

A file that merely exists is not enforcement: `check` requires the named test to actually be in it, matched on whole words, so `test_login_matrix_extra` never satisfies a claim about `test_login`.

The hook matches the **text being written**, never the file path — path filters rot as code moves. Rules can also declare `endpoints:`, matched on resource segments, so a backend rule reaches a client that shares the route but not the vocabulary.

## The ADR file

`enforced-by` names the artifacts that hold the invariant. Two shapes, both checked:

```yaml
enforced-by:
  - type: test                       # the file must exist AND name this test
    file: tests/auth/test_login.py   #   inside test_globs, resolved to a real
    name: test_entry_points          #   path inside the repo
  - type: lint                       # existence only (spec §6.2)
    file: ci/checks/no-direct-session.sh
```

### Resolving is not enforcing

An artifact resolves when its file exists and names what it claims. It is
**enforced** only when something actually runs it. `check` is contracted fast,
offline and deterministic, so it executes nothing — but it can tell that an
entry with no `run:` command and no built-in rule could never hold an
invariant, and it says so:

```
ADR-001  accepted      2  ok
    declared: tests/auth.py names test_matrix, but `check` does not run it

1 ADR · 1 accepted · 0 enforced

CLASS-4 COUNT: 1   (uninsured exposure — nothing but attention holds these)
```

The gate still passes: the artifact is real and your CI may well run it. What
changes is the count. **An invariant nothing executes is exposure, whatever the
frontmatter declares**, and the class-4 number is the one you report upward.

`accepted` + class 1-3 requires at least one entry that resolves. `accepted` +
class 4 requires a written `justification`. A rule with no `symbols` and no
`endpoints` fails: the hook could never surface it, so nothing would ever
deliver it to anyone.

For a rule spanning repos, `enforced-by` may be a map instead. The gate verifies
the repo it runs in and reports the rest as `unverified` rather than passing
them silently:

```yaml
enforced-by:
  centaur-tech:
    - { type: test, file: tests/auth_matrix.py, name: test_entry_points }
  mobile:
    - { type: test, file: src/auth/login.test.ts, name: rejects_deactivated }
```

### Citing another decision — including one in another ledger

```yaml
cites:
  - ADR-002                 # this ledger
  - harmost/ADR-004         # an installed package's ledger
  - "@acme/rules/ADR-011"   # a scoped package
```

A citation is checked, not decorative. If the reference does not parse, or names
a package with no ledger installed here, or names an ADR that ledger does not
hold, `check` fails. A reference that resolves to nothing is worse than an
absent one, because it reads as authority.

**Cited decisions are delivered too.** When the hook matches a decision, it also
injects what that decision cites, so the rule behind the rule reaches the agent
rather than living in whoever read the file. Two bounds, both structural:

- **Depth 1.** A citation of a citation is not followed. The matched decision is
  the rule; a cited one is why that rule has its shape; anything past that is two
  removes from the code on screen, and following the graph is how the whole
  ledger arrives.
- **A byte budget, not a count.** `max_injected_chars` bounds the whole
  injection. Counts are the wrong bound: dropping the fourth of eight matching
  decisions requires knowing which matters least, and only matched decisions can
  be ranked at all — a cited one has no order but the one its author typed.

**Nothing is dropped in silence.** The header states how many decisions cover the
edit, not how many fit, and anything left out is named:

```
5 architectural decisions cover the code you are editing.

4 of these are not included below — the injection budget is 1200 characters.
Read them before you write: ADR-002, ADR-003, ADR-004, ADR-005
```

Reporting fewer rules than cover an edit is not a smaller answer, it is a false
one: an agent told three rules apply has no reason to look for a fourth.

This is what makes an upstream rule more than a link. A tool's own governance
decisions — how an ADR is amended, what an accepted one must carry — are rules
*about* ledgers, so every ledger is their subject. Shipped inside the package
they are read-only by construction, and pinned by the lockfile, so a rule added
upstream arrives through a deliberate upgrade rather than on its own.

## `check --json`

A stable contract, versioned by `version`. Additive changes only within a major.

```json
{
  "version": 1,
  "tool": "harmost",
  "ok": false,
  "summary": { "total": 2, "accepted": 2, "enforced": 1, "class4": 1, "unverified": 0 },
  "adrs": [
    {
      "id": "ADR-001",
      "status": "accepted",
      "class": 2,
      "verdict": "pass",
      "file": "ADR-001-deactivated-users-must-never-authenticate.md",
      "failures": [],
      "unverified_repos": []
    }
  ]
}
```

`verdict` is `pass`, `fail`, or `unverified`. `ok` is false iff any verdict is
`fail`; that is exactly when the command exits 1. `enforced` counts artifacts
that **resolved**, never artifacts that were merely declared.

## Threat model

The ledger is trusted input. `check` validates frontmatter and humans ratify;
neither the gate nor the hook is a boundary against hostile ADR *prose*.

The hook delivers a matched ADR's **full markdown, verbatim** — that is the
point, and it means an ADR body can contain arbitrary text, including text
shaped like another ADR's header. The hook's own framing stays accurate: it
labels each block with the status read from validated frontmatter, states
plainly how many rules are ratified versus proposed, and `check` reports the
real counts. But a body can still assert things about itself in prose, and no
amount of fencing would prevent that. Review ADRs the way you review CI config.

Enforcement artifacts are resolved inside the repository — a path that escapes
via `..` or a symlink is refused, so a verdict never depends on a file that is
absent from a clean clone.

## Design

- **Git is canonical.** The ledger is text in a repo: diffed, blamed, reviewed, rebuildable. Any index or dashboard is derived, never the source.
- **Deterministic.** No LLM calls anywhere in this package. The gate is a plain CLI command, so it runs in any CI system.
- **No daemon, no database, no network.**

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Requires Node >= 22.12.

`harmost` implements the Archon invariant-enforcement methodology.

---

*ἁρμοστής — the officer who fits things into order. From ἁρμόζω, "to join, to bring into conformance"; the same root as* harmony.
