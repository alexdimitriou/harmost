---
id: ADR-NNN
title: <one sentence, stated as the rule>
status: proposed          # proposed | accepted | superseded | rejected
enforcement-class: 4      # 1 structural | 2 tested | 3 static | 4 review-only
invariant: >
  One sentence saying what must always — or must never — hold.
applies-to:
  - "src/**"              # informational globs
symbols:                  # content-match terms; the hook greps edited text for these
  - <identifier>
endpoints: []             # optional: API routes, matched on resource segments.
                          # Reaches clients that share the route but not the
                          # vocabulary — e.g. "/AppUsers/login".
enforced-by:              # required when status: accepted and class is 1-3
  []
supersedes: null
justification: null       # required prose when enforcement-class is 4
---

## Context

What is true about the system that makes this rule necessary? If this ADR came
from an escape, name the incident.

## Decision

The rule, stated so that a violation is unambiguous.

> **State only what the artifacts below enforce.** Nothing checks this section
> against them — prose is not machine-readable — so a Decision that claims more
> than its enforcement holds is shipped to an agent as fact on every matching
> edit, and the gate stays green over it. Anything you intend but do not yet
> enforce belongs in its own `proposed` ADR.
>
> This section is the one the hook delivers. An accepted ADR without it reaches
> the agent as a title and nothing else.

## Enforcement

What makes this rule hold, and why it is that class rather than a stronger one.

> Default question: **why is this NOT class 1?**
> Anything below structural needs a written reason here.

## Dial-backs

Optional. One row per concession.

| Constraint | Conceded | Class chosen instead | Upgrade cost | Revisit trigger |
|---|---|---|---|---|
