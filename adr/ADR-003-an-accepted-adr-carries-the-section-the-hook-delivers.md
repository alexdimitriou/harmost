---
id: ADR-003
title: "An accepted ADR carries the section the hook delivers"
date: 2026-08-26
status: proposed
enforcement-class: 3
invariant: >
  An accepted ADR carries the section the hook delivers
applies-to:
  - "src/check.ts"
  - "src/hook.ts"
  - "templates/**"
symbols:
  - "decisionSection"
  - "bodyOfTemplate"
  - "MAX_BODY_CHARS"
  - "renderContext"
endpoints: []                # optional API routes, matched on resource segments
enforced-by:
  - file: "src/check.test.ts"
    type: test
    name: "an accepted ADR with no `## Decision` fails — the hook would deliver a title"
supersedes: null
justification: null
---


## Context

`check` validated frontmatter and never read the body. The hook sends exactly one
body section — `## Decision` — and omits it silently when it is missing. So an
accepted ADR without that section passed the gate, matched an edit, injected a
title and an invariant, and said nothing about the rule. The agent is handed a
heading where a decision should be, and no one is told.

That is the deliverability failure the gate already refuses one step earlier. An ADR
whose matchers can never reach an edit fails with *"the hook could never surface this
rule"*. An ADR the hook does reach and has nothing to say about is the same hole,
later in the same path.

Found by winging it: the ADR bodies in this ledger were written freehand, and nothing
would have objected to writing none at all.

## Decision

An ADR with `status: accepted` contains a `## Decision` section with text under it.
Proposed ADRs are exempt — a decision still being drafted has not claimed anything.

No other section is required. Context, Enforcement and Dial-backs are written for the
human reviewing the decision, and a structural check on them is satisfied by an empty
heading — an artifact that exists and holds nothing, which is the failure this project
exists to name.

## Enforcement

Class 3 — `check` reads the body of every accepted ADR and fails when the section is
absent, covered by `src/check.test.ts`.

**Status is `proposed`, and the reason is the point.** The artifact above is a test,
and `verify` cannot execute a test: `type: test` always resolves `declared`, so
accepting this ADR would make this project's own ledger `inert` and turn its gate red.
**harmost cannot currently verify class-2 enforcement at all** — `choke-point` is the
only rule it can evaluate, and a gate's own behaviour is not a symbol-placement
problem. Recording this as accepted-at-class-4 would understate a rule that is
genuinely tested; recording it as accepted-at-class-3 would claim a check the gate
cannot make. Proposed is the honest state, and it graduates the day artifact execution
lands.

**Why this is not class 1.** A missing section cannot be made unrepresentable in a
markdown file. The nearest structural move — generating the Decision heading into
every file `new` writes — is already true and did not help: the heading survives while
the text under it is deleted, and a heading with nothing under it is what the hook
would ship.

## Dial-backs

| Constraint | Conceded | Class chosen instead | Upgrade cost | Revisit trigger |
|---|---|---|---|---|
| `verify` cannot execute a test artifact | The ADR stays `proposed`; nothing gates it | **4** — recorded and delivered, guaranteed by nothing | Artifact execution (Q8) | Test execution ships |
| Nothing can compare a Decision's prose to what its artifacts enforce | The rule covers presence, never adequacy | **4** — template wording only, and it cannot be otherwise | None available | — |
