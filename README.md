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
