#!/usr/bin/env python3
"""
helots-lint.py — PostToolUse hook: run linter after editing source files.

Fires after Edit, Write, NotebookEdit.
Detects the appropriate linter for the file type:
  TypeScript/JavaScript: biome check (if configured), else eslint
  Python:                ruff check
  Rust:                  cargo clippy (project-level, run from Cargo.toml root)

Silent on pass. Injects errors as additionalContext on failure.
Toggle: add "helots-lint" to .claude/hooks.json "disabled" list.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled

TS_JS_EXTS  = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'}
PYTHON_EXTS = {'.py'}
RUST_EXTS   = {'.rs'}


def find_cargo_root(start: pathlib.Path) -> pathlib.Path | None:
    for parent in [start, *start.parents]:
        if (parent / 'Cargo.toml').exists():
            return parent
    return None


def run_lint(file_path: pathlib.Path, cwd: pathlib.Path) -> str | None:
    """Run appropriate linter. Returns error output or None on pass/skip."""
    ext = file_path.suffix.lower()

    if ext in TS_JS_EXTS:
        local_biome = cwd / 'node_modules' / '.bin' / 'biome'
        has_biome_json = (cwd / 'biome.json').exists()

        if has_biome_json and local_biome.exists():
            cmd = [str(local_biome), 'check', str(file_path)]
        elif shutil.which('biome') and has_biome_json:
            cmd = ['biome', 'check', str(file_path)]
        else:
            local_eslint = cwd / 'node_modules' / '.bin' / 'eslint'
            if local_eslint.exists():
                cmd = [str(local_eslint), '--max-warnings=0', str(file_path)]
            elif shutil.which('eslint'):
                cmd = ['eslint', '--max-warnings=0', str(file_path)]
            else:
                return None

    elif ext in PYTHON_EXTS:
        if not shutil.which('ruff'):
            return None
        cmd = ['ruff', 'check', str(file_path)]

    elif ext in RUST_EXTS:
        if not shutil.which('cargo'):
            return None
        cargo_root = find_cargo_root(file_path.parent)
        if not cargo_root:
            return None
        result = subprocess.run(
            ['cargo', 'clippy', '--message-format=short', '--', '-D', 'warnings'],
            cwd=str(cargo_root),
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = (result.stdout + result.stderr).strip()
        return output if result.returncode != 0 and output else None

    else:
        return None

    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=30,
    )
    output = (result.stdout + result.stderr).strip()
    return output if result.returncode != 0 and output else None


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

    if not is_enabled('helots-lint', cwd):
        sys.exit(0)

    p = pathlib.Path(file_path)
    if not p.is_absolute():
        p = pathlib.Path(cwd) / p

    if not p.exists():
        sys.exit(0)

    errors = run_lint(p, pathlib.Path(cwd))
    if not errors:
        sys.exit(0)

    out = {
        'hookSpecificOutput': {
            'hookEventName': 'PostToolUse',
            'additionalContext': f'[helots-lint] lint errors after edit:\n{errors}',
        }
    }
    print(json.dumps(out))
    sys.exit(0)


if __name__ == '__main__':
    main()
