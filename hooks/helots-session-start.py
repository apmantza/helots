#!/usr/bin/env python3
"""
helots-session-start.py — SessionStart hook: inject project context at session open.

Injects into additionalContext:
  - Current git branch and last commit message
  - Count of uncommitted changes
  - Last auto-summary block from MEMORY.md (if present)

Keeps it tight — this fires on every session start so must be fast and concise.

Toggle: add "helots-session-start" to .claude/hooks.json "disabled" list.
"""

import json
import pathlib
import re
import subprocess
import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled


def run(cmd: list[str], cwd: str) -> str:
    try:
        result = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip()
    except Exception:
        return ''


def git_context(cwd: str) -> str | None:
    branch = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    if not branch:
        return None

    last_commit = run(['git', 'log', '-1', '--pretty=%s'], cwd)
    dirty = run(['git', 'status', '--porcelain'], cwd)
    changed_count = len([l for l in dirty.splitlines() if l.strip()])

    parts = [f'Branch: {branch}']
    if last_commit:
        parts.append(f'Last commit: {last_commit}')
    if changed_count:
        parts.append(f'Uncommitted changes: {changed_count} file(s)')
    else:
        parts.append('Working tree: clean')

    return ' | '.join(parts)


def last_memory_summary(transcript_path: str) -> str | None:
    """Extract the most recent Auto-Summary block from MEMORY.md."""
    if not transcript_path:
        return None

    t = pathlib.Path(transcript_path)
    memory_path = t.parent / 'memory' / 'MEMORY.md'
    if not memory_path.exists():
        return None

    try:
        text = memory_path.read_text(encoding='utf-8')
        # Find all Auto-Summary blocks
        blocks = re.findall(
            r'## Auto-Summary \[([^\]]+)\][^\n]*\n(.*?)(?=\n## |\Z)',
            text,
            re.DOTALL,
        )
        if not blocks:
            return None
        # Take the last one, trim to 300 chars
        ts, content = blocks[-1]
        content = content.strip()
        if len(content) > 300:
            content = content[:300] + '...'
        return f'Last session summary ({ts}):\n{content}'
    except Exception:
        return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    cwd = data.get('cwd', '')
    transcript_path = data.get('transcript_path', '')

    if not is_enabled('helots-session-start', cwd):
        sys.exit(0)

    parts = []

    git_info = git_context(cwd)
    if git_info:
        parts.append(git_info)

    summary = last_memory_summary(transcript_path)
    if summary:
        parts.append(summary)

    if not parts:
        sys.exit(0)

    context = '[helots-session-start]\n' + '\n\n'.join(parts)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == '__main__':
    main()
