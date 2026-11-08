---
name: writing-tests
description: How to write tests that catch wrong implementations - choosing behaviors, levels, test doubles, determinism, and mutation-style adequacy checks. Read when running /testgen or /qe, adding tests to existing code, or when tests pass but bugs still ship.
---

# Writing tests that matter

A good test fails when the behavior it names breaks, and only then. Judge tests by **what wrong implementation they would catch**, not by coverage percentage.

## 1. Decide what to test

Derive behaviors from the code and its callers, then list them before writing:
- **Contract of each public entry point**: inputs → outputs and side effects.
- **Boundaries**: empty, one, many; 0, -1, max; first/last element; exactly-at-limit vs one-over; unicode, whitespace, very long strings; duplicate keys; time boundaries (midnight, DST, month end, leap day).
- **Error paths**: invalid input, collaborator failure, timeout, partial failure, retry exhaustion. Assert the error type/message/status, not just "throws".
- **Invariants**: round-trip, idempotence, commutativity, ordering, conservation (sums match), monotonicity.
- **State machines**: each legal transition, and that illegal transitions are rejected.
Skip: trivial getters, framework behavior, third-party library internals, and private helpers (test them through the public behavior).

## 2. Pick the level

| Level | Use for | Doubles |
|---|---|---|
| Unit | pure logic, calculations, parsing, validation | none, or fakes for owned interfaces |
| Property | invariants over wide input spaces (fast-check, hypothesis, proptest) | none |
| Integration | your code + real DB/filesystem/queue (in-memory or container) | only third-party network |
| Contract | API/message shapes consumers depend on | provider or consumer stub |
| End-to-end | a few critical user journeys | none |

Prefer the lowest level that can catch the bug. Push logic out of I/O-heavy code so it can be unit tested.

## 3. Structure

- Name = behavior + condition: `charges no shipping when cart total exceeds threshold`.
- Arrange-Act-Assert, visually separated. One behavior per test; multiple asserts are fine if they describe one outcome.
- No branching or loops in test bodies, except table-driven tests (`it.each`, `pytest.mark.parametrize`, Go table tests) where each row is labeled.
- Build data with factories or builders that set only what the test cares about; hide the rest behind defaults. Literal values that matter must be visible in the test.
- Assert on observable outcomes (return values, persisted state, emitted events, HTTP responses), not on internal calls, unless the interaction *is* the behavior (e.g., "sends exactly one email").
- Exact assertions: `toEqual(expected)` over `toBeTruthy()`; check the specific error, not any error.

## 4. Test doubles

- **Fake** (working in-memory implementation) > **stub** (canned answers) > **mock** (interaction verification).
- Mock what you do not own (HTTP APIs, payment providers) behind your own interface, then test the adapter separately with recorded responses or a contract test.
- Never mock the unit under test or its value objects. If a test needs five mocks, the unit has too many collaborators.
- Restore all spies/mocks after each test.

## 5. Determinism

- Inject or fake the clock; set the time zone explicitly (`TZ=UTC`) where dates matter.
- Seed randomness; avoid asserting on UUIDs or ordering of unordered collections (sort first).
- No real network. No dependence on test order or shared mutable state; each test creates what it needs and cleans up (unique temp dirs, transactions rolled back, random ports).
- Wait on conditions, not durations: `await waitFor(...)`, never `sleep(500)`.

## 6. Adequacy: would it catch a bug?

Run a mutation tool if present (Stryker, mutmut, cargo-mutants, go-mutesting) scoped to the changed file. Otherwise mutate by hand, one at a time, and revert each:
- flip a comparison (`<` ↔ `<=`, `==` ↔ `!=`);
- change a boundary constant by one;
- delete a function call or a line with a side effect;
- return a constant/empty value early;
- swap `&&`/`||`, negate a condition.
Every mutant should make at least one test fail. A surviving mutant is either a missing test or dead/equivalent code; decide which.

## 7. Red flags in existing tests

Assertion-free tests; tests that only check "does not throw"; snapshots as the only assertion on logic; tests mirroring the implementation line by line with mocks; `.skip`/`xit` without an issue link; retries or inflated timeouts masking flakiness; tests that pass when the function body is deleted.

Adapted from agentic-qe `qe-test-generation`, `mutation-testing`, and `test-design-techniques` (MIT, Agentic QE Contributors) and ruflo-testgen (MIT, ruvnet).
