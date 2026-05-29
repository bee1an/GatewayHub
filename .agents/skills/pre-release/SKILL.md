---
name: pre-release
description: Pre-release checklist that runs every quality gate before tagging and publishing. Use when the user asks "ready to release?", "can we ship?", "pre-release check", "发布前检查", "能发版了吗". Inspect only — never bump versions, edit changelog, commit, tag, or push.
---

# Pre-release

Last check before tagging. Run the fixed TODO in order. Stop on the first failure.

## Fixed TODO

Create these tasks via TaskCreate in order. Mark `in_progress` before running, `completed` only after the command succeeds. On any failure, stop immediately and report.

- [ ] **Lint must pass** — run the project's lint command (`npm run lint`, `eslint`, `ruff`, etc.). Zero errors.
- [ ] **Typecheck must pass** — run the project's typecheck command (`npm run typecheck`, `tsc --noEmit`, `mypy`, `cargo check`, etc.). Zero errors.
- [ ] **Tests must pass** — run the project's test command. Zero failures, no unexpected skips.
- [ ] **Version follows semver** — compare `package.json` version with the latest tag (`git tag --sort=-version:refname | head -1`). Allowed: `+1` on patch, minor, or major (lower segments reset). Forbidden: skipping numbers (e.g. `0.0.1` → `0.0.3`), going backwards, or bumping a segment that does not match the change type.
- [ ] **CHANGELOG updated** — `CHANGELOG.md` has a top-most section matching the new version, dated today, with entries for every user-facing commit since the last tag.

## Hard Rules

- Inspect only. Never edit files, commit, tag, or push.
- A `pass` requires a command that actually ran in this session.
- Stop at the first failed item. Do not run later steps.

## Report Format

```
lint:       pass | fail
typecheck:  pass | fail
tests:      pass | fail (N failed)
version:    <pkg version> vs last tag <tag> — pass | fail (<reason>)
changelog:  pass | fail (<reason>)

verdict: READY | NOT READY

blockers:
- ...
```
