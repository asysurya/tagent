# TaskFlow — Agent Guide

## Project
Vanilla JS + CSS todo app. No build step — everything runs by opening `index.html`.

## Conventions
- Keep it dependency-free: vanilla JS only.
- State lives in `tasks` (localStorage-backed).
- All DOM updates go through `renderTasks()` — keep it the single render path.
