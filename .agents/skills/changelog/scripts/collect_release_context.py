#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path


def run_git(args: list[str], cwd: Path) -> str:
    result = subprocess.run(
        ['git', *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def repo_root(cwd: Path) -> Path:
    return Path(run_git(['rev-parse', '--show-toplevel'], cwd).strip())


def read_package_version(root: Path) -> str:
    package_json = root / 'package.json'
    data = json.loads(package_json.read_text(encoding='utf-8'))
    version = data.get('version')
    if not isinstance(version, str) or not version.strip():
        raise RuntimeError('package.json version is missing or invalid')
    return version.strip()


def resolve_commit(ref: str, root: Path) -> str:
    return run_git(['rev-parse', ref], root).strip()


def tags_pointing_at(ref: str, root: Path) -> list[str]:
    output = run_git(['tag', '--points-at', ref], root).strip()
    return [line for line in output.splitlines() if line]


def merged_tags(ref: str, root: Path) -> list[str]:
    output = run_git(['tag', '--merged', ref, '--sort=-creatordate'], root).strip()
    return [line for line in output.splitlines() if line]


def resolve_start_tag(to_ref: str, root: Path) -> tuple[str | None, str | None]:
    reachable = merged_tags(to_ref, root)
    exact = set(tags_pointing_at(to_ref, root))
    candidates = [tag for tag in reachable if tag not in exact]
    if candidates:
        return candidates[0], None
    if reachable:
        return None, 'No earlier reachable tag exists before the target ref; using full history.'
    return None, 'No reachable release tag exists; using full history.'


def commit_range(from_tag: str | None, to_ref: str) -> list[str]:
    if from_tag:
        return [f'{from_tag}..{to_ref}']
    return [to_ref]


def collect_commits(root: Path, from_tag: str | None, to_ref: str) -> list[dict[str, str]]:
    args = [
        'log',
        '--reverse',
        '--date=short',
        '--format=%H%x1f%h%x1f%ad%x1f%an%x1f%s%x1f%b%x1e',
        *commit_range(from_tag, to_ref)
    ]
    output = run_git(args, root)
    commits: list[dict[str, str]] = []
    for chunk in output.split('\x1e'):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split('\x1f', 5)
        while len(parts) < 6:
            parts.append('')
        full_hash, short_hash, authored_date, author_name, subject, body = parts
        commits.append(
            {
                'hash': full_hash,
                'short_hash': short_hash,
                'authored_date': authored_date,
                'author_name': author_name,
                'subject': subject.strip(),
                'body': body.strip()
            }
        )
    return commits


def normalize_name_status(parts: list[str]) -> tuple[str, str | None]:
    status = parts[0]
    base_status = status[0]
    if base_status in {'R', 'C'}:
        if len(parts) < 3:
            return base_status, None
        return base_status, parts[2]
    if len(parts) < 2:
        return base_status, None
    return base_status, parts[1]


def collect_changed_files(root: Path, from_tag: str | None, to_ref: str) -> list[dict[str, object]]:
    args = ['log', '--format=commit:%H', '--name-status', *commit_range(from_tag, to_ref)]
    output = run_git(args, root)
    summaries: dict[str, dict[str, object]] = defaultdict(
        lambda: {'path': '', 'change_types': set(), 'touched_commits': 0}
    )

    current_commit = None
    seen_in_commit: set[str] = set()
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith('commit:'):
            current_commit = line.removeprefix('commit:')
            seen_in_commit = set()
            continue
        if current_commit is None:
            continue
        parts = raw_line.split('\t')
        change_type, path = normalize_name_status(parts)
        if not path:
            continue
        entry = summaries[path]
        entry['path'] = path
        change_types = entry['change_types']
        assert isinstance(change_types, set)
        change_types.add(change_type)
        if path not in seen_in_commit:
            entry['touched_commits'] = int(entry['touched_commits']) + 1
            seen_in_commit.add(path)

    return sorted(
        [
            {
                'path': path,
                'change_types': sorted(entry['change_types']),
                'touched_commits': entry['touched_commits']
            }
            for path, entry in summaries.items()
        ],
        key=lambda item: (-int(item['touched_commits']), str(item['path']))
    )


def build_payload(root: Path, from_tag: str | None, to_ref: str, version: str) -> dict[str, object]:
    to_commit = resolve_commit(to_ref, root)
    commits = collect_commits(root, from_tag, to_ref)
    changed_files = collect_changed_files(root, from_tag, to_ref)
    fallback_reason = None
    if from_tag is None:
        _, fallback_reason = resolve_start_tag(to_ref, root)

    return {
        'repository': root.name,
        'version': version,
        'release_date': date.today().isoformat(),
        'from_tag': from_tag,
        'to_ref': to_ref,
        'to_commit': to_commit,
        'range_mode': 'tag_range' if from_tag else 'full_history',
        'range_spec': f'{from_tag}..{to_ref}' if from_tag else to_ref,
        'fallback_reason': fallback_reason,
        'head_tags': tags_pointing_at(to_ref, root),
        'heading': f'## {version} - {date.today().isoformat()}',
        'stats': {
            'commit_count': len(commits),
            'file_count': len(changed_files)
        },
        'commits': commits,
        'changed_files': changed_files
    }


def resolve_inputs(root: Path, args: argparse.Namespace) -> tuple[str | None, str, str]:
    version = args.version or read_package_version(root)
    to_ref = args.to_ref or 'HEAD'
    from_tag = args.from_tag
    if from_tag is None:
        from_tag, _ = resolve_start_tag(to_ref, root)
    return from_tag, to_ref, version


def format_text(payload: dict[str, object]) -> str:
    lines = [
        f"Repository: {payload['repository']}",
        f"Version: {payload['version']}",
        f"Heading: {payload['heading']}",
        f"Range: {payload['range_spec']}",
        f"Mode: {payload['range_mode']}",
    ]
    if payload['fallback_reason']:
        lines.append(f"Fallback: {payload['fallback_reason']}")
    lines.append(f"Commits: {payload['stats']['commit_count']}")
    lines.append(f"Files: {payload['stats']['file_count']}")
    lines.append('')
    lines.append('Top commits:')
    for commit in payload['commits'][:10]:
        lines.append(f"- {commit['short_hash']} {commit['subject']}")
    lines.append('')
    lines.append('Top changed files:')
    for item in payload['changed_files'][:10]:
        change_types = ','.join(item['change_types'])
        lines.append(f"- {item['path']} [{change_types}] x{item['touched_commits']}")
    return '\n'.join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Collect release context from Git for changelog writing.'
    )
    parser.add_argument('--from-tag', help='Explicit start tag for the release range')
    parser.add_argument('--to-ref', help='Target ref for the release range', default='HEAD')
    parser.add_argument('--version', help='Override version instead of reading package.json')
    parser.add_argument('--json', action='store_true', help='Emit machine-readable JSON')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cwd = Path.cwd()

    try:
        root = repo_root(cwd)
        from_tag, to_ref, version = resolve_inputs(root, args)
        payload = build_payload(root, from_tag, to_ref, version)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(format_text(payload))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
