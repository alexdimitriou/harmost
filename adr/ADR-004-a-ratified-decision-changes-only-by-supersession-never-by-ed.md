---
id: ADR-004
title: "A ratified Decision changes only by supersession, never by edit"
date: 2026-08-26
status: proposed
enforcement-class: 3
invariant: >
  A ratified Decision changes only by supersession, never by edit
applies-to:
  - "src/check.ts"
  - "src/ledger.ts"
  - "adr/**"
symbols:
  - "supersedes"
  - "superseded"
  - "renderFrontmatter"
  - "STATUSES"
endpoints: []                # optional API routes, matched on resource segments
enforced-by: []
supersedes: null
justification: null
---


## Context

An ADR here is not a historical document. The hook injects its `## Decision` into an
agent's context on every matching edit, and the gate certifies it in CI. So the
ledger is read by machines, continuously, as current instruction.

That makes the orthodox rule — *never edit an ADR, always supersede* — insufficient
in one direction and unaffordable in the other. Insufficient, because a Decision that
is wrong about the present is not a stale archive entry; it is a false instruction
shipped to an agent repeatedly, at exactly the moment it writes the code the rule
governs. Unaffordable, because agents write and edit ADRs, so "we do not edit them"
is a convention held by whoever remembers it.

The incident is this ledger's sibling: BusMan's ADR-001 stated that its factory takes
a window's *"chat surface and tools definition"* as required arguments. The tools half
was never built — a single global tool constant is passed wholesale to the model. The
clause described enforcement that did not exist, in the one section the hook delivers
verbatim.

## Decision

Two acts, kept apart:

**A ratified Decision does not change.** Deciding something different means a new ADR
with `supersedes:` set and the old one moved to `status: superseded`. An accepted
Decision edited in place is a rule nobody ratified.

**A Decision that was never true about the present is corrected in place**, with a
dated amendment section stating what it said, why it was wrong, and that the decision
itself did not change. This is repair of a live document, not revision of a record.

The line between them is whether the world changed or the text was wrong about it.

## Enforcement

Class 3 — intended, not built. `harmost.lock` records the hash of each accepted ADR's
`## Decision` at ratification, alongside the violation baseline it will already carry.
An edited Decision then fails the gate unless the ADR's status moves or `supersedes`
is set. Amendment stops being a text edit anyone can make silently and becomes a
reviewable act.

**Status is `proposed` because the lock does not exist.** Until it does, this rule is
held by nothing but attention — class 4 in fact, whatever it says — and the amendment
note in a diff is the only signal.

**Why this is not class 1.** Nothing can prevent a file from being edited. The
guarantee available is that an edit cannot pass the gate unnoticed, which is class 3,
and it is the strongest form this rule has.

## Dial-backs

| Constraint | Conceded | Class chosen instead | Upgrade cost | Revisit trigger |
|---|---|---|---|---|
| `harmost.lock` does not exist | No detection of a silent Decision edit | **4** — a dated amendment note, visible only in review | The lock, plus a hash per accepted Decision | The lock ships |
| The correct/supersede distinction needs judgment | Cannot be automated | **4** — stated here so the judgment is at least a considered one | None available | — |
