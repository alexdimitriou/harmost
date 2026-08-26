---
id: ADR-002
title: "The product name is hard-coded in exactly one module"
date: 2026-08-26
status: accepted
enforcement-class: 3
invariant: >
  The product name is hard-coded in exactly one module
applies-to:
  - "src/**"
symbols:
  - "PRODUCT_NAME"
  - "CONFIG_FILE"
  - "INVOCATION"
  - "DEFAULT_ADR_DIR"
endpoints: []                # optional API routes, matched on resource segments
enforced-by:
  - rule: choke-point
    symbol: "harmost"
    in: ["src/**"]
    only-from: ["src/name.ts"]
supersedes: null
justification: null
---


## Context

A rename is the cheapest decision to reverse and the most expensive to get
wrong late. `src/name.ts` already states the rule in prose — *"code must not
hard-code the name outside one constant"* — and derives every user-facing
string, filename and config key from `PRODUCT_NAME`. Prose is class 4.

The incident is this ADR's own session: writing `verify` introduced two
hard-coded occurrences in comments within minutes, and the rule caught them
the first time it ran. Neither would have broken a rename; both would have
gone stale, and a stale comment about the product's own name is the kind of
thing nobody fixes and everybody half-believes.

## Decision

The literal product name appears in exactly one module, `src/name.ts`. Every
other module derives what it needs from the constants that module exports.

This binds comments as well as strings. Reading the rule as "user-facing
strings only" would need a parser to enforce and would leave the ledger's own
prose drifting from the code — a distinction that costs more to police than
the rule costs to obey.

## Enforcement

Class 3 — a `choke-point` rule over `src/**`, evaluated by `verify`. Test files
are excluded by `test_globs`: a test names what it checks.

**Why this is not class 1.** Nothing in the type system can stop a string
literal from containing a word. The nearest structural alternative — deriving
the name at build time so the literal cannot be typed — costs a build step and
buys a guarantee the static check already provides at merge.

## Dial-backs

Optional. One row per concession.

| Constraint | Conceded | Class chosen instead | Upgrade cost | Revisit trigger |
|---|---|---|---|---|
