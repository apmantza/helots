#!/usr/bin/env python3
"""
helots-gitstage.py — PostToolUse hook: git add any file written/edited by Claude.

Fires after Edit, Write, NotebookEdit.
Stages the file immediately so helots-autocommit.py picks it up on Stop.
Uses the exact file_path from tool_input — no scanning needed.
"""

import json
import pathlib
import subprocess
import sys


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get('tool_input', {})
    file_path = tool_input.get('file_path') or tool_input.get('notebook_path', '')
    cwd = data.get('cwd', '')

    if not file_path or not cwd:
        sys.exit(0)

    # Resolve absolute path
    p = pathlib.Path(file_path)
    if not p.is_absolute():
        p = pathlib.Path(cwd) / p

    if not p.exists():
        sys.exit(0)

    # Must be inside a git repo
    result = subprocess.run(
        ['git', 'rev-parse', '--is-inside-work-tree'],
        cwd=cwd, capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.exit(0)

    # git add the specific file (works for both new and modified)
    subprocess.run(
        ['git', 'add', str(p)],
        cwd=cwd, capture_output=True, text=True,
    )
    sys.exit(0)


if __name__ == '__main__':
    main()
