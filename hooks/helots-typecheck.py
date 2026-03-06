#!/usr/bin/env python3
"""
helots-typecheck.py — PostToolUse hook: run tsc --noEmit after editing .ts files.

Fires after Edit, Write, NotebookEdit on TypeScript files.
Runs npx tsc --noEmit from the project root, compresses output,
and injects errors as additionalContext. Silent on pass.

Toggle: add "helots-typecheck" to .claude/hooks.json "disabled" list.
"""

import json
import os
import pathlib
import subprocess
import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled

TS_EXTS = {'.ts', '.tsx'}


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get('tool_input', {})
    file_path = tool_input.get('file_path', '')
    cwd = data.get('cwd', '')

    if not file_path or not cwd:
        sys.exit(0)

    if not is_enabled('helots-typecheck', cwd):
        sys.exit(0)

    if pathlib.Path(file_path).suffix.lower() not in TS_EXTS:
        sys.exit(0)

    # Find tsconfig.json walking up from cwd
    tsconfig = None
    for parent in [pathlib.Path(cwd), *pathlib.Path(cwd).parents]:
        candidate = parent / 'tsconfig.json'
        if candidate.exists():
            tsconfig = str(parent)
            break

    if not tsconfig:
        sys.exit(0)

    hooks_dir = pathlib.Path(__file__).parent
    compress = str(hooks_dir / 'helots-compress.py')

    result = subprocess.run(
        [sys.executable, compress, '--run', 'npx tsc --noEmit'],
        cwd=tsconfig,
        capture_output=True,
        text=True,
        timeout=30,
    )

    output = (result.stdout + result.stderr).strip()

    # Silent on clean pass
    if result.returncode == 0 or not output:
        sys.exit(0)

    out = {
        'hookSpecificOutput': {
            'hookEventName': 'PostToolUse',
            'additionalContext': f'[helots-typecheck] tsc errors after edit:\n{output}',
        }
    }
    print(json.dumps(out))
    sys.exit(0)


if __name__ == '__main__':
    main()
