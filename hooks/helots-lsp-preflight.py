#!/usr/bin/env python3
"""
helots-lsp-preflight.py — PreToolUse hook: inject current diagnostics before editing code files.

Fires before Edit/Write on .ts/.tsx/.py/.rs files.
Runs the appropriate type-checker to show the CURRENT error state before Claude writes,
so Claude knows the baseline and isn't chasing pre-existing issues.

Silent if no errors or no type-checker found.
"""

import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled

CODE_EXTS = {'.ts', '.tsx', '.py', '.rs'}


def find_tsconfig_root(start: pathlib.Path) -> str | None:
    for parent in [start, *start.parents]:
        if (parent / 'tsconfig.json').exists():
            return str(parent)
    return None


def run_cmd(cmd: list[str], cwd: str, timeout: int = 20) -> str:
    try:
        result = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
        )
        output = (result.stdout + result.stderr).strip()
        # Return output only on failure
        return output if result.returncode != 0 else ''
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ''


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get('tool_input', {})
    file_path = tool_input.get('file_path', '')
    cwd = data.get('cwd', '') or os.getcwd()

    if not file_path:
        sys.exit(0)

    ext = pathlib.Path(file_path).suffix.lower()
    if ext not in CODE_EXTS:
        sys.exit(0)

    if not is_enabled('helots-lsp-preflight', cwd):
        sys.exit(0)

    errors = ''

    if ext in {'.ts', '.tsx'}:
        tsroot = find_tsconfig_root(pathlib.Path(file_path).parent)
        if tsroot:
            errors = run_cmd(['npx', 'tsc', '--noEmit', '--pretty', 'false'], cwd=tsroot)

    elif ext == '.py':
        errors = run_cmd(['pyright', '--outputjson'], cwd=cwd)
        if errors:
            # pyright --outputjson returns JSON — extract just the summary line
            try:
                parsed = json.loads(errors)
                diags = parsed.get('generalDiagnostics', [])
                errors = '\n'.join(
                    f"{d.get('file','')}:{d.get('range',{}).get('start',{}).get('line',0)+1}: {d.get('message','')}"
                    for d in diags if d.get('severity') == 'error'
                )[:800]
            except Exception:
                errors = errors[:800]

    elif ext == '.rs':
        errors = run_cmd(['cargo', 'check', '--message-format=short'], cwd=cwd)

    if not errors:
        sys.exit(0)

    # Truncate to avoid flooding context
    if len(errors) > 600:
        errors = errors[:600] + '\n...[truncated]'

    out = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'additionalContext': (
                f'[helots-lsp-preflight] Baseline diagnostics BEFORE your edit '
                f'(pre-existing — not caused by your change):\n{errors}'
            ),
        }
    }
    print(json.dumps(out))
    sys.exit(0)


if __name__ == '__main__':
    main()
