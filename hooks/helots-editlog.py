#!/usr/bin/env python3
"""
helots-editlog.py — PostToolUse hook: log frontier Edit/Write ops to events.jsonl.

Fires after Edit, Write on any file.
Appends {"type":"frontier_edit","file":"..."} to .helot-mcp-connector/events.jsonl
so hoplite's commit-message workflow has a full session picture.

Toggle: add "helots-editlog" to .claude/hooks.json "disabled" list.
"""

import json
import os
import pathlib
import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled
from datetime import datetime, timezone


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get('tool_input', {})
    cwd = data.get('cwd', '')

    if not cwd:
        sys.exit(0)

    if not is_enabled('helots-editlog', cwd):
        sys.exit(0)

    # Edit uses file_path, Write uses file_path too
    file_path = tool_input.get('file_path', '')
    if not file_path:
        sys.exit(0)

    # Make path relative to cwd for readability
    try:
        rel = str(pathlib.Path(file_path).relative_to(cwd))
    except ValueError:
        rel = file_path

    events_file = pathlib.Path(cwd) / '.helot-mcp-connector' / 'events.jsonl'
    events_file.parent.mkdir(parents=True, exist_ok=True)

    event = {
        'ts': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') +
              f'{datetime.now(timezone.utc).microsecond // 1000:03d}Z',
        'type': 'frontier_edit',
        'file': rel,
    }

    try:
        with open(events_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(event) + '\n')
    except Exception:
        pass

    sys.exit(0)


if __name__ == '__main__':
    main()
