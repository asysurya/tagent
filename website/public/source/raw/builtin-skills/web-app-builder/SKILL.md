---
name: web-app-builder
description: Playbook for building a complete web app in the workspace — structure, styling quality, and verification loops.
usage: Follow when asked to build or significantly extend a web application, website, landing page, or dashboard.
tags: web, frontend
---

# Web App Builder

When asked to build or significantly extend a web application, follow this playbook.

## Steps

1. **Clarify scope.** Restate the request in one sentence, list the deliverables, and propose a file plan before writing code.
2. **Scaffold.**
   - Static site → `index.html`, `styles.css`, `app.js`.
   - Component app → set up `src/` with components, hooks, and a `README.md`.
3. **Design quality rules (non-negotiable):**
   - Mobile-first, responsive layout.
   - Real content — no `lorem ipsum`; write plausible copy.
   - Accessible: semantic HTML, labels, keyboard focus states.
   - Subtle transitions (`150–250ms`), consistent spacing scale.
4. **State and logic.** Keep logic in small pure functions; no global soup. Handle loading and error states explicitly.
5. **Verify.** If bash is available: run a dev/build check. If the browser tool is available: open the page, take a screenshot, read console errors, fix, repeat.
6. **Document.** Update `README.md` with how to run and what was built.

## Output expectations

- Use `write_file` for new files, `edit_file` for surgical changes.
- Keep a todo list via `todowrite` when the task has 3+ steps.
- After finishing, summarize: files created/changed, how to run, and what to verify.
