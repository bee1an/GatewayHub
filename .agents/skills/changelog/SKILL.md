---
name: changelog
description: Write and update the repository changelog in CHANGELOG.md using package.json version, Git tags, and Git history. Use when asked to write changelog, update release notes, summarize changes from the previous tag to the current commit, or generate a new release section from Git changes, including requests such as "写 changelog", "更新发布日志", or "根据 tag 到当前提交生成版本说明".
---

# Changelog

Write the root `CHANGELOG.md` by summarizing changes from the previous release tag to the current commit.

## Workflow

1. Assume the working directory is the repository root.
2. Run `python3 .agents/skills/changelog/scripts/collect_release_context.py --json` first.
3. Read `references/changelog-format.md` before drafting or editing the changelog.
4. Inspect the current `CHANGELOG.md` so the new section is inserted below the intro, not appended to the bottom.
5. **CHECKPOINT 1 — Version Confirmation**: Present the resolved version number to the user and ask for explicit confirmation before proceeding. If the user wants a different version, use their override.
6. Draft one new release section with the confirmed version and today's date.
7. **CHECKPOINT 2 — Changelog Content Confirmation**: Present the full drafted changelog section to the user. Wait for explicit approval. If the user requests edits, revise and re-present until approved.
8. Once approved, write the section into `CHANGELOG.md`.
9. If the corresponding Git tag exists, sync the changelog to GitHub Release (see GitHub Release Sync below).

## Defaults

- Default output target: root `CHANGELOG.md`
- Default version source: `package.json`
- Default Git range: previous reachable release tag to `HEAD`
- If `HEAD` is already tagged, use the next older reachable tag so the range stays non-empty.
- If no earlier tag exists, fall back to full reachable history and state that fallback in the draft notes or working summary.

## Overrides

- If the user gives a version, tag, or target ref, honor it over the defaults.
- Use `--from-tag`, `--to-ref`, and `--version` on the helper script when the release range must be overridden.

## Writing Rules

- Write for end users, not maintainers reading commit logs.
- Merge related commits into a few high-signal bullets.
- Do not dump raw commit subjects verbatim.
- Keep low-signal docs-only or internal-only maintenance out of the main bullets unless it materially affects users or release flow.
- Preserve the existing changelog style used in this repository.

## Skip Rules

The following types of changes should NOT appear in the changelog — ignore them entirely:

- Commits that only modify comments, whitespace, or formatting
- Changes only to CI config, linter config, or editor config
- Routine dependency version bumps with no functional impact
- Pure variable renames or file moves with no behavior change
- Test code additions/modifications/deletions (no user-visible impact)
- Typo fixes

If ALL commits in a release range fall into the above categories, do not generate a new changelog section. Inform the user why instead.

## GitHub Release Sync

After the changelog section is written to `CHANGELOG.md`:

1. Check if the version tag exists: `git tag -l v<version>`
2. If the tag exists, check if a GitHub Release already exists: `gh release view v<version>`
3. If no Release exists, create one: `gh release create v<version> --title "v<version>" --notes-file -` (pipe the changelog section via stdin)
4. If a Release already exists, update it: `gh release edit v<version> --notes-file -`
5. If the tag does not exist yet, skip this step and only update the local `CHANGELOG.md`.
