---
name: bug-hunter
description: Debug-first workflow — reproduce, isolate, fix, and regression-protect a bug with evidence at every step.
usage: Follow when something is broken and needs a reliable fix — reproduce, isolate, fix, then protect with a regression check.
tags: debug, bug, test
---

# Bug Hunter

Use this when something is broken and you need a reliable fix.

## Workflow

1. **Reproduce.** Find the exact trigger. If a command/run is possible, capture the real error output (`bash`, or the browser console via the `browser` tool).
2. **Isolate.** Bisect: read the involved files (`read_file`, `grep`), trace the data flow, and state the suspected root cause BEFORE changing anything.
3. **Red test first (when possible).** Write a minimal failing check (script, test file, or manual browser step) that fails now and should pass after the fix.
4. **Fix minimally.** Smallest change that addresses the root cause — no drive-by refactors.
5. **Prove it.** Re-run the reproduction. Show the before/after output.
6. **Guard.** Leave a comment or test so this bug cannot silently return.

## Rules

- Never claim "fixed" without evidence from a re-run.
- If the root cause is ambiguous, present the 2–3 candidate causes ranked, with the check that would distinguish them.
