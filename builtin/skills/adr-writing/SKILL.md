---
name: adr-writing
description: How to write, number, and maintain Architecture Decision Records. Read when running /adr, when a change introduces a new dependency, boundary, data store, protocol, or pattern, or when someone asks "why did we do it this way?"
---

# Writing ADRs

An ADR records **one** architecturally significant decision: the context that forced it, the options weighed, the choice, and its consequences. It is written for an engineer two years from now who wants to know whether the reasons still hold.

## When a decision deserves an ADR

Write one when the decision is costly to reverse or affects many files or teams:
- adding a framework, database, queue, or major dependency;
- defining or changing a module/context boundary or dependency rule;
- choosing a protocol, data format, or API style;
- a cross-cutting pattern (error handling, auth, caching, multi-tenancy);
- deliberately accepting a known trade-off (consistency vs availability, buy vs build).
Do not write one for routine implementation choices that a code review covers.

## Template (use the repo's own if one exists)

```
# ADR-NNNN: <Decision as a short noun phrase or imperative>
Status: proposed | accepted | rejected | deprecated | superseded by ADR-MMMM
Date: YYYY-MM-DD
Deciders: <people or roles>
Tags: <area>

## Context
The forces at play: the problem, constraints (technical, organizational, regulatory),
and facts with sources (code paths, metrics, incidents, docs). Neutral tone; no decision yet.

## Options considered
### A. <name>
Summary. Pros. Cons. Cost and reversibility.
### B. <name>
...
(Always include the status quo or "do nothing" when it is viable.)

## Decision
We will <decision>. One paragraph explaining why this option best satisfies the forces above.

## Consequences
Positive: ...
Negative: ... (what gets harder; the debt we accept)
Neutral: ... (what changes but is neither good nor bad)
Follow-ups: <tasks this creates>

## Links
Supersedes / related ADRs, issues, PRs, docs.
```

## Writing rules

- **One decision per ADR.** If you write "and also", split it.
- **Context carries evidence.** "p95 latency is 1.8s on /search (dashboard link)" beats "search is slow". Cite `path:line` for code constraints.
- **Real options.** At least two genuinely viable options, each with honest cons. A straw-man alternative is a sign the decision was made before the analysis.
- **Consequences include the negatives.** An ADR with only positive consequences is advocacy, not a record.
- **State what would make you revisit it** ("if write volume exceeds 5k/s", "if the vendor drops the free tier").
- Short: most ADRs fit on one screen. Link out for depth.
- Write in plain language; define acronyms once.

## Lifecycle

```
proposed → accepted → deprecated
       ↘ rejected    ↘ superseded by ADR-MMMM
```
- ADRs are **immutable once accepted**, apart from status and links. To change a decision, write a new ADR that supersedes the old one, and link both ways.
- Rejected ADRs are kept; they prevent relitigating.
- Numbering is sequential and never reused. Match the repo's scheme (`0007-use-postgres.md`, `ADR-007-...`).
- Keep an index (table of number, title, status, date) in the ADR directory README if the repo has one.

## Keeping code and decisions in sync

- Reference the ADR in code where the decision is enforced or surprising: `// See ADR-0012: all writes go through the outbox`.
- When reviewing a diff, check accepted ADRs whose decision text names the touched modules; flag contradictions with both citations.
- Where cheap, encode the decision as a check (lint rule, dependency-cruiser/import-linter rule, architecture test) and link it from the ADR.

Adapted from the ruflo-adr plugin and its REFERENCE.md (MIT, ruvnet), and Michael Nygard's original ADR format.
