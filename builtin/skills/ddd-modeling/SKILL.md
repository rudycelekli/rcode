---
name: ddd-modeling
description: Domain-Driven Design reference for bounded contexts, aggregates, value objects, events, and repositories. Read when running /ddd, designing a domain model, splitting a module by business capability, or judging whether code respects domain boundaries.
---

# DDD modeling

Use this as a working reference, not a religion. DDD pays off where the domain is complex and the language is contested. For CRUD over a database, a thin service layer is fine; say so instead of forcing patterns.

## Strategic design

**Bounded context**: a boundary inside which every term has one meaning. Signals that you need a boundary:
- the same word means different things to different people or modules (`Order` in sales vs fulfillment; `Account` in billing vs auth);
- different rates of change or different teams;
- one model is bending to serve two masters (fields only one caller uses, flags that switch behavior per caller).

**Context map relationships** (name them explicitly when mapping):
| Relationship | What it looks like in code |
|---|---|
| Upstream/downstream | B imports A's public API; A does not know B |
| Shared kernel | a small shared module both depend on; changes need both owners |
| Anti-corruption layer (ACL) | B translates A's model into its own types at the edge |
| Published language | a versioned schema/contracts package (OpenAPI, proto, JSON Schema) |
| Conformist | B uses A's internal model directly; cheapest, couples most |
| Separate ways | no integration; duplication is accepted |

Default to ACLs around third-party and legacy systems. Conformist is acceptable when the upstream is stable and well designed; name it so it is a choice, not an accident.

## Tactical building blocks

**Entity**: identity that persists through changes (`User#42`). Equality by id.

**Value object**: defined by its attributes, immutable, self-validating (`Money(amount, currency)`, `EmailAddress`, `DateRange`). Equality by value. Replace primitives that carry rules: a `string` email validated in five places should be one `EmailAddress` type validated once at construction.

**Aggregate**: a cluster of entities and values with one root that enforces invariants. Rules:
1. External code holds references only to the root, and only by id across aggregates.
2. All changes go through methods on the root that keep invariants true (`order.addLine(...)`, not `order.lines.push(...)`).
3. No public setters, no exposed mutable collections (return copies or read-only views).
4. One transaction modifies one aggregate. Cross-aggregate consistency is eventual, via domain events.
5. Keep aggregates small. Ask: "What must be consistent *immediately*?" Only that belongs inside.

**Domain event**: a fact that happened, named in past tense (`OrderPlaced`, `PaymentFailed`), immutable, carrying the data consumers need plus id and timestamp. Raised by aggregates, dispatched after the transaction commits (outbox pattern when delivery must be reliable).

**Repository**: collection-like access to aggregate roots only. The **interface** lives in the domain layer, phrased in domain terms (`findPendingOlderThan(date)`); the **implementation** lives in infrastructure (ORM, SQL). No repositories for non-root entities.

**Domain service**: an operation that does not naturally belong to one entity (a transfer between two accounts). Stateless. Not a dumping ground; if most logic lives in services and entities are bags of getters, the model is anemic.

**Application service / use case**: orchestrates a single use case: load aggregate, call domain methods, save, publish events. Holds transactions and authorization; holds no business rules.

## Layering and dependency direction

```
interface (HTTP, CLI, UI)  →  application  →  domain  ←  infrastructure
```
Domain imports nothing from frameworks, ORMs, HTTP, or other contexts' internals. Infrastructure implements domain interfaces (dependency inversion).

## Smells to report

- Domain file imports ORM/HTTP/framework modules (LAYER).
- Context A imports `contextB/internal/...` instead of B's public API (BOUNDARY).
- Invariants checked in controllers or handlers rather than in the aggregate (INVARIANT).
- `setStatus()` callable from anywhere; status transitions not guarded by a state machine.
- Events named as commands (`SendEmail`) or mutable after creation (EVENT).
- One "God" model used by every context with nullable fields per use case.
- Cyclic imports between contexts (CYCLE).

## Modeling procedure

1. Collect the language: nouns and verbs from code, docs, UI copy, and user conversations. Note synonyms and homonyms.
2. Group by capability and by which terms change together; draw candidate boundaries.
3. For each context: list commands (intent), events (facts), and invariants (rules that must always hold).
4. Choose aggregates around invariants, not around tables.
5. Define the published API of each context; everything else is internal.
6. Record boundary decisions as ADRs.

Adapted from the ruflo-ddd plugin (MIT, ruvnet) and standard DDD literature (Evans, Vernon).
