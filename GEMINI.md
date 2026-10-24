# Workspace Engineering Directive: Root-Cause System Architecture

## 1. No Shallow Fixes or Band-Aids
- Never patch only the immediate symptom of a failure.
- Never write superficial prompt-tweaks, message-hiding hacks, or local string checks when the underlying issue is an architectural state machine or lifecycle flaw.
- Audit the **entire state machine contract** from first principles:
  - How is progress defined and verified?
  - Are success/failure invariants strictly enforced by state, or left to heuristic guessing?
  - Are detection algorithms mathematically reachable and covering edge cases (e.g. no-op edits, identical-size diffs)?

## 2. Tests Are Incomplete by Default
- Passing existing unit tests does **not** prove correctness. Existing tests usually only cover happy paths or the flawed architecture's original assumptions.
- Identify the blind spots in the test suite itself:
  - What edge cases is the current test suite failing to catch?
  - Write new, rigorous invariant tests (testing failure modes, no-ops, state regressions, and oscillation) before declaring victory.

## 3. Deep Systemic Healing Over "Least Disruptive Change"
- Do not optimize for the smallest diff just to keep old tests green.
- If the foundation or contract is flawed, refactor and strengthen the base architecture.
- Ensure the fix permanently prevents the entire class of problem from ever recurring.
