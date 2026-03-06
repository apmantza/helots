#!/usr/bin/env python3
"""
helots-test-runner.py — PostToolUse hook: run tests after helot_run completes.

Fires after mcp__helots__helot_run calls.
Auto-detects test runner in the project, runs tests with a timeout,
compresses failures, and injects results as additionalContext.

If all tests pass: silent (no noise).
If tests fail: injects compressed failure output for Claude to act on.
Toggle via .claude/hooks.json: {"disabled": ["helots-test-runner"]}
"""

import json
import re
import subprocess
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled

TIMEOUT = 60        # seconds before giving up
MAX_LINES = 50      # max compressed output lines to inject


# ── Test runner detection ────────────────────────────────────────────────────

def _read_json(p: pathlib.Path) -> dict:
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _read_text(p: pathlib.Path) -> str:
    try:
        return p.read_text(encoding='utf-8')
    except Exception:
        return ''


def detect_runner(cwd: str) -> tuple[list[str], str] | None:
    """Return (command_list, type_hint) or None if no runner found."""
    root = pathlib.Path(cwd)

    # ── TypeScript / JavaScript ──────────────────────────────────────────────
    pkg = _read_json(root / 'package.json')
    if pkg:
        test_script = pkg.get('scripts', {}).get('test', '')
        # Detect jest
        if 'jest' in test_script:
            local = root / 'node_modules' / '.bin' / 'jest'
            base = [str(local)] if local.exists() else ['npx', 'jest']
            return base + ['--passWithNoTests'], 'npm_test'
        # Detect vitest
        if 'vitest' in test_script:
            local = root / 'node_modules' / '.bin' / 'vitest'
            base = [str(local)] if local.exists() else ['npx', 'vitest']
            return base + ['run'], 'npm_test'
        # Generic npm test (skip placeholder scripts)
        _placeholder = ('echo "Error: no test specified"', '')
        if test_script and test_script not in _placeholder:
            return ['npm', 'test'], 'npm_test'

    # Jest / Vitest config without test script
    for cfg in ['jest.config.js', 'jest.config.ts', 'jest.config.mjs']:
        if (root / cfg).exists():
            local = root / 'node_modules' / '.bin' / 'jest'
            base = [str(local)] if local.exists() else ['npx', 'jest']
            return base + ['--passWithNoTests'], 'npm_test'
    for cfg in ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs']:
        if (root / cfg).exists():
            local = root / 'node_modules' / '.bin' / 'vitest'
            base = [str(local)] if local.exists() else ['npx', 'vitest']
            return base + ['run'], 'npm_test'

    # ── Python ───────────────────────────────────────────────────────────────
    if (root / 'pytest.ini').exists() or (root / 'setup.cfg').exists():
        return ['python', '-m', 'pytest', '-x', '--tb=short', '-q'], 'pytest'
    if '[tool.pytest' in _read_text(root / 'pyproject.toml'):
        return ['python', '-m', 'pytest', '-x', '--tb=short', '-q'], 'pytest'

    # ── Rust ─────────────────────────────────────────────────────────────────
    if (root / 'Cargo.toml').exists():
        return ['cargo', 'test'], 'cargo_test'

    # ── Go ───────────────────────────────────────────────────────────────────
    if (root / 'go.mod').exists():
        return ['go', 'test', './...'], 'go_test'

    # ── TypeScript only (no test framework) — type-check ────────────────────
    if (root / 'tsconfig.json').exists():
        import shutil
        tsc = shutil.which('tsc')
        if tsc:
            return [tsc, '--noEmit'], 'tsc'

    return None


# ── Output compression ───────────────────────────────────────────────────────

def compress(lines: list[str], runner_type: str) -> list[str]:
    """Extract failure lines and summary; pass through if already short."""
    if len(lines) <= 20:
        return lines

    out: list[str] = []

    if runner_type == 'pytest':
        in_fail = False
        for line in lines:
            s = line.rstrip()
            if re.match(r'_{3,}.*FAILED|^FAILED |=+ FAILURES =+', s):
                in_fail = True
            if in_fail and (re.match(r'\s+E\s+', s) or 'AssertionError' in s or 'Error' in s):
                out.append(s)
            if re.match(r'=+ short test summary|=+ \d+ (passed|failed)', s):
                out.append(s)
                in_fail = False

    elif runner_type in ('npm_test',):
        for line in lines:
            s = line.rstrip()
            if (re.search(r'(FAIL|✗|✘|×|FAILED)', s)
                    or 'AssertionError' in s
                    or re.match(r'\s+Error:', s)
                    or re.search(r'\d+ (passed|failed|skipped)', s)):
                out.append(s)

    elif runner_type == 'tsc':
        for line in lines:
            if re.search(r'error TS\d+|warning TS\d+|Found \d+ error', line):
                out.append(line.rstrip())

    elif runner_type == 'cargo_test':
        for line in lines:
            s = line.rstrip()
            if 'FAILED' in s or 'panicked' in s or s.startswith('test result:'):
                out.append(s)

    elif runner_type == 'go_test':
        for line in lines:
            s = line.rstrip()
            if s.startswith('--- FAIL') or s.startswith('FAIL') or 'panic:' in s:
                out.append(s)

    else:
        non_empty = [l.rstrip() for l in lines if l.strip()]
        return non_empty[:MAX_LINES]

    return out if out else lines[:MAX_LINES]


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    cwd = data.get('cwd', '')
    if not is_enabled('helots-test-runner', cwd):
        sys.exit(0)

    runner = detect_runner(cwd)
    if not runner:
        sys.exit(0)

    cmd, runner_type = runner

    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        context = f'[helots-test-runner] Tests timed out after {TIMEOUT}s — results unavailable.'
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': context}}))
        sys.exit(0)
    except Exception:
        sys.exit(0)  # runner not installed — graceful skip

    if result.returncode == 0:
        sys.exit(0)  # all green — stay silent

    raw = (result.stdout + result.stderr).splitlines()
    compressed = compress(raw, runner_type)[:MAX_LINES]
    trailer = f'  ... ({len(raw) - MAX_LINES} more lines omitted)' if len(raw) > MAX_LINES else ''

    lines = [f'[helots-test-runner] Tests FAILED after helot_run ({runner_type}):']
    lines += compressed
    if trailer:
        lines.append(trailer)

    output = {
        'hookSpecificOutput': {
            'hookEventName': 'PostToolUse',
            'additionalContext': '\n'.join(lines),
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == '__main__':
    main()
