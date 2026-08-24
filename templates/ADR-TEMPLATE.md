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

## Enforcement

What makes this rule hold, and why it is that class rather than a stronger one.

> Default question: **why is this NOT class 1?**
> Anything below structural needs a written reason here.

## Dial-backs

Optional. One row per concession.

| Constraint | Conceded | Class chosen instead | Upgrade cost | Revisit trigger |
|---|---|---|---|---|
