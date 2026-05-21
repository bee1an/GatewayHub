# Changelog Format

Use this reference when updating the repository root `CHANGELOG.md`.

## Target Shape

Insert a new section directly below the changelog intro:

```md
## <version> - <YYYY-MM-DD>

<one short summary sentence>

- <bullet 1>
- <bullet 2>
- <bullet 3>
```

## Required Rules

- Take `<version>` from `package.json` unless the user explicitly provides another version.
- Take the date from the current local day in `YYYY-MM-DD`.
- Write exactly one short summary sentence before the bullets.
- Write 3 to 6 bullets by default.
- Keep bullets user-facing and release-oriented.

## Content Selection

Prefer these changes:

- product-facing features
- bug fixes
- desktop UX or account-flow changes
- CLI capabilities and behavior changes
- packaging, installer, or release behavior changes

De-prioritize or omit these changes unless they materially affect the release:

- pure documentation edits
- trivial refactors with no visible behavior change
- internal cleanup
- maintenance noise that does not change shipped behavior

## Compression Rules

- Merge related commits into one bullet when they serve the same user-facing outcome.
- Convert implementation details into outcome language.
- Mention important surfaces explicitly when relevant: desktop app, gateway server, CLI, packaging.
- Avoid one bullet per commit unless the commits are clearly unrelated and all release-worthy.

## Source-of-Truth Workflow

1. Use `scripts/collect_release_context.py --json` to collect the release range.
2. Treat the Git range as the default source of truth.
3. Use the changed files only as supporting context for grouping and wording.
4. Re-read the current `CHANGELOG.md` before inserting the new section so the style stays consistent.

## Style Notes

- Keep the changelog concise.
- Summary sentences should read like release summaries, not engineering notes.
- Bullets should usually start with `Added`, `Improved`, `Fixed`, or another outcome verb when it reads naturally.
