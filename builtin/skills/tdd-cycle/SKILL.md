---
name: tdd-cycle
description: Strict red-green-refactor discipline with observed failures. Read when running /tdd, /sparc refinement, or whenever implementing behavior test-first, or when a test passes suspiciously on its first run.
---

# The TDD cycle

The value of TDD comes from **watching each test fail for the right reason** before making it pass. A test you never saw fail might be testing nothing.

## The loop

```
pick next behavior → RED (write one test, see it fail on an assertion)
                   → GREEN (minimal code, see it pass)
                   → REFACTOR (clean up with tests green)
                   → repeat
```

### Red
1. Write **one** test for the next small behavior. Name it as a behavior: `rejects passwords shorter than 12 characters`.
2. Run only that test (single-test command, not the whole suite).
3. Read the failure. It must be an **assertion failure about the behavior**:
   - Good: `expected false, received true`; `expected 400, got 200`.
   - Not yet: `Cannot find module`, `X is not a function`, `NameError`, syntax errors. Add the minimum scaffolding (an empty function, a type, an export) and re-run until the failure is the assertion.
4. If it **passes** immediately: either the behavior already exists (delete the test or keep it as characterization, and say so) or the test is wrong (it does not exercise what you think). Find out which before continuing.

### Green
1. Write the least code that makes the test pass. Hardcoding a return value is legitimate when the next test will force generalization.
2. Run the single test, then the file. Do not add behavior no test asks for.

### Refactor
1. Only on green. Remove duplication, improve names, extract functions, in production and test code.
2. Re-run after each change. If red, undo the refactor step rather than debugging forward.

## Choosing the next test

Order: degenerate case (empty, zero, null) → simplest happy path → variations that force generalization (triangulation) → boundaries → error paths → interactions.
When stuck, pick a smaller behavior. If a test needs more than ~10 lines of setup, the design is telling you something: extract a collaborator or a builder.

## Observed-result contract

- Report each red and green with the exact command, exit code, and the relevant failure line.
- Skipped, filtered-out, or unrun tests are **not** success. Check the runner's summary counts: "0 tests ran" is a failure of the harness, not a pass.
- Never write "this should pass now"; run it.
- The final suite run happens **after the last edit**, including refactors and formatting.

## Styles

- **Classicist (Chicago):** real collaborators where cheap; assert on outcomes and state. Default choice; tests survive refactors.
- **Mockist (London):** mock collaborators to drive out interfaces from the outside in; assert on interactions. Useful at boundaries and for designing roles; brittle if overused on internals.
Mix: outside-in with a mock at the boundary you are designing, classicist inside.

## Anti-patterns

- Writing several tests before any implementation.
- Changing the test to match the implementation without a stated reason.
- Testing private functions directly instead of through behavior.
- Assertion-free tests, or asserting only that "no error was thrown" when there is a return value to check.
- Snapshot tests as the only assertion for logic.
- `.only`, `.skip`, retries, or extended timeouts left in.
- Mocking the unit under test, or mocking so much that the test re-states the implementation.

Adapted from ruflo-testgen `tdd-workflow` (MIT, ruvnet) and agentic-qe `strict-tdd` and `tdd-london-chicago` (MIT, Agentic QE Contributors).
