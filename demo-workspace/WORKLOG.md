# Worklog

## 2026-09-16

- **11:02 — fix render loop** app.js re-rendered the whole list on every keystroke; diffed by id now.
- **11:20** found the counter bug: `remaining` counted deleted items too. Patched with a filter first.
- **11:41 — add persistence** todos now persist to localStorage; loaded on boot.

## 2026-09-17

- **09:15 — keyboard shortcuts** Enter adds, Escape clears the input, ArrowUp edits the last item.
- **09:32** cleaned styles.css: removed the duplicate `.done` rule that struck through everything.
