#!/usr/bin/env python3
"""
helots-filesize.py — PreToolUse hook: warn when writes exceed 500 lines.

Fires before Write and Edit tool calls.
  Write: counts lines in content directly.
  Edit:  estimates final count from current file size + net line delta.

Never blocks — always allow + additionalContext nudge to split.
Toggle via .claude/hooks.json: {"disabled": ["helots-filesize"]}
"""

import json
import os
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled

MAX_LINES = 500


def current_line_count(file_path: str) -> int:
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    cwd = data.get('cwd', '')
    if not is_enabled('helots-filesize', cwd):
        sys.exit(0)

    tool_name  = data.get('tool_name', '')
    tool_input = data.get('tool_input', {})
    final_lines: int | None = None
    file_path = ''

    if tool_name == 'Write':
        file_path   = tool_input.get('file_path', '')
        content     = tool_input.get('content', '')
        final_lines = len(content.splitlines())

    elif tool_name == 'Edit':
        file_path   = tool_input.get('file_path', '')
        old_string  = tool_input.get('old_string', '')
        new_string  = tool_input.get('new_string', '')
        current     = current_line_count(file_path) if file_path else 0
        delta       = len(new_string.splitlines()) - len(old_string.splitlines())
        final_lines = current + delta

    else:
        sys.exit(0)

    if final_lines is None or final_lines <= MAX_LINES:
        sys.exit(0)

    fname = os.path.basename(file_path) if file_path else 'this file'
    context = (
        f"[helots-filesize] {fname} will be {final_lines} lines after this write "
        f"(limit: {MAX_LINES}). Consider splitting into multiple focused files — "
        f"extract helpers, types, or secondary classes into separate modules before proceeding."
    )

    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'additionalContext': context,
        }
    }))
    sys.exit(0)


if __name__ == '__main__':
    main()
