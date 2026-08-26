---
id: ADR-001
title: "A repository's violation count must never rise above its ratified baseline"
date: 2026-08-26
status: proposed
enforcement-class: 2
invariant: >
  A repository's violation count must never rise above the baseline recorded at
  its last ratification; the gate fails on a rise, not on a non-zero count.
applies-to:
  - "src/check.ts"
  - "src/cli.ts"
  - "src/report-check.ts"
symbols:
  - "CheckReport"
  - "exitCode"
  - "baseline"
  - "ratchet"
  - "summarise"
endpoints: []                # optional API routes, matched on resource segments
enforced-by: []
supersedes: null
justification: null
---


## Context

`check` is binary today. The exit code is `report.ok ? 0 : 1` (`src/cli.ts:81-86`),
where `ok = results.every(r => r.verdict !== "fail")` (`src/check.ts:297`), and the
only flag is `--json`. There is no baseline, tolerance, or prior count anywhere in
the gate.

A greenfield repository starts at zero, so this costs nothing there. Every
brownfield repository starts above zero, and for those the tool currently offers
two choices, both bad:

- **a permanently red pipeline**, which teams route around within a week, or
- **`continue-on-error: true`**, which is class 4 — the count lands in the log and
  nothing reads it.

Neither is adoption. This is log entry 36 one level up: the product whose entire
position is an *ordinal* enforcement taxonomy hands brownfield adopters a binary.
The escape that named it is the BusMan launcher pilot (log entries 46–48) — window
construction is scattered across AI-written call sites, so the gate goes red on day
one, and the pilot's whole purpose is to watch that number come **down**.

There is a second, quieter cost. The before/after case study is only evidence if
both pilots run the same configuration. A greenfield repo gated one way and a
brownfield repo gated another produce two curves that cannot be compared.

## Decision

`check` reads a committed `harmost.lock` recording, per ADR, the violation count at
the last ratification. The gate fails **only when a count rises above its recorded
baseline**. It does not fail on a non-zero count.

- A count that falls rewrites the lock in the same commit that lowers it. The new,
  lower number becomes the ceiling and is never raised again — that is the ratchet.
- A count that rises fails the gate, and names which ADR rose and by how much.
- An ADR absent from the lock has an implicit baseline of zero, so a **new** rule
  is held at zero from the moment it is accepted. Adoption is grandfathered;
  ratification is not.
- The lock is committed, never generated at gate time. A baseline the CI computes
  for itself is not a baseline — it is whatever today's code happens to contain.

Report-only stops being a mode. Zero is the terminal case of the same mechanism, so
both pilots run identical config and the two curves are comparable.

## Enforcement

Class 2 — an invariant test over the lock's monotonicity: a synthetic report whose
count exceeds the lock must exit 1; one at or below must exit 0; a rewrite must
never raise a recorded number.

**Why this is not class 1.** Monotonicity is a property of a sequence of runs over
time, not of a single value, so no type or construction can make a rise
unrepresentable — the gate has to compare against committed state and decide.
Class 1 covers what *can* be structural, and one part is: the lock is a plain
committed file, so lowering the ceiling requires a reviewable diff rather than a
CI-side setting a single person can flip.

**Deliberately deferred:** the lock's *format*. It is fixed after the BusMan
pilot produces a real count, not before. Designing a schema against an imagined
brownfield repository is the mistake log entry 42 already paid for once.

## Dial-backs

| Constraint | Conceded | Class chosen instead | Upgrade cost | Revisit trigger |
|---|---|---|---|---|
| BusMan needs a gate in AGC's CI tonight; the lock is unbuilt | No baseline state at all; the pipeline runs `harmost check` under `continue-on-error: true` | **4** — the count reaches the log and nothing reads it. Justified only as a dated, logged concession (tracker entry 48), not as a supported mode | ~1 evening once the lock format is fixed | The BusMan count moves twice, or any second brownfield repo asks for the same wiring |
| The lock format needs a real brownfield count as input | `harmost.lock` not shipped in v0.2 | **—** (this ADR stays `proposed`; nothing is claimed as held) | This ADR accepted + its monotonicity test | First real count recorded in the tracker's *Violation counts* table |
