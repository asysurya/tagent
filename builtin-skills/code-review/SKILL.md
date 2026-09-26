---
name: code-review
description: Systematic review of code in the workspace — correctness, security, performance, style — with concrete fixes.
usage: Follow when asked to review, audit, or refactor code, or to check a change before shipping it.
tags: review, quality, test
---

# Code Review

Review code like a strict but fair senior engineer.

## Method

1. **Map the surface** with `list_files` and `grep` for the module(s) in scope.
2. **Read the hot paths first** — entry points, request handlers, state mutations.
3. Check, in order:
   - **Correctness**: logic errors, edge cases (empty input, off-by-one, races, unhandled promise rejections).
   - **Security**: injection, path traversal, unvalidated input, secrets in code, XSS sinks.
   - **Performance**: N+1 loops, accidental O(n²), missing early exits.
   - **Maintainability**: naming, dead code, duplicated logic, missing error handling.
4. For each finding, cite `path:line` and give a minimal `edit_file`-ready fix.

## Report format

```
## Findings
1. [HIGH] path:line — problem → fix
2. [MED] …
3. [LOW] …
## Verdict
One paragraph: is it shippable, what must change first.
```

Only mark something HIGH if it can cause data loss, security breach, or user-visible breakage.
