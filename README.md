# harmost

**Your review burden shouldn't scale with your agents' output. It should scale with your *decisions* — and decay as your system matures.**

Diff review scales with how much code an agent writes. That is a treadmill: the faster the agent, the more there is to read, and making the reading easier doesn't remove the treadmill. Reviewing *decisions* scales with something else — the rate at which genuinely new architectural rules enter the system — and that rate falls as a domain matures. Six months in, most agent work lands under rules a human already ratified once, and needs no human at all.

`harmost` is the machinery that makes that true: an **ADR ledger in git**, a **coverage gate in CI**, and **deterministic context delivery** to the coding agent.

> **Status: v0.0.1 — this release reserves the name and publishes the command surface.**
> The tracer bullet (`init`, `new`, `check`, `hook`) lands in **v0.1.0**.

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

Point the new ADR's `enforced-by` at a test that doesn't exist yet and `check` fails by name. Write the test and it passes. Then edit any code containing `create_session` and the hook puts the rule in front of the agent before it writes a line — because it was asked to, deterministically, not because it remembered.

## Design

- **Git is canonical.** The ledger is text in a repo: diffed, blamed, reviewed, rebuildable. Any index or dashboard is derived, never the source.
- **Deterministic.** No LLM calls anywhere in this package. The gate is a plain CLI command, so it runs in any CI system.
- **No daemon, no database, no network.**

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

`harmost` implements the Archon invariant-enforcement methodology.

---

*ἁρμοστής — the officer who fits things into order. From ἁρμόζω, "to join, to bring into conformance"; the same root as* harmony.
