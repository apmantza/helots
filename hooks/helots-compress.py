#!/usr/bin/env python3
"""
helots-compress.py — Output compression for frontier token savings.

Two modes:
  1. CLI wrapper: runs a command and compresses its stdout
       python3 helots-compress.py --run "npx tsc --noEmit"
       python3 helots-compress.py --run "pytest tests/"

  2. PostToolUse hook: reads MCP tool output from stdin, compresses, returns
     updatedMCPToolOutput JSON. Wire into settings.json PostToolUse hook.
       echo '<json>' | python3 helots-compress.py --hook

Compression strategies by output type:
  - tsc:    keep only error lines (TS\\d+), file:line:col references, summary
  - pytest: keep only FAILED lines, assertion messages, short summary
  - npm test / vitest: keep only failing test names and error messages
  - git diff: keep only +/- lines with minimal context, strip binary/whitespace diffs
  - generic: deduplicate consecutive repeated lines, truncate if still large
"""
import json
import os
import re
import subprocess
import sys

# Lines above this threshold trigger compression
LINE_THRESHOLD = 80
# Hard cap on output lines after compression
MAX_LINES = 60


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------

def detect_type(command: str) -> str:
    cmd = command.strip().lower()
    if re.search(r'\btsc\b', cmd):
        return 'tsc'
    if re.search(r'\bpytest\b', cmd):
        return 'pytest'
    if re.search(r'\bpython\b.*\s-m\s+pytest', cmd):
        return 'pytest'
    if re.search(r'\bnpm\s+(run\s+)?test\b', cmd):
        return 'npm_test'
    if re.search(r'\bvitest\b', cmd):
        return 'npm_test'
    if re.search(r'\bcargo\s+test\b', cmd):
        return 'cargo_test'
    if re.search(r'\bgo\s+test\b', cmd):
        return 'go_test'
    if re.search(r'\bgit\s+diff\b', cmd):
        return 'git_diff'
    return 'generic'


# ---------------------------------------------------------------------------
# Compressors
# ---------------------------------------------------------------------------

def compress_tsc(lines: list[str]) -> list[str]:
    """Keep error/warning lines and the summary line. Drop info/progress."""
    out = []
    for line in lines:
        stripped = line.rstrip()
        # TypeScript error pattern: file(line,col): error TSxxxx:
        if re.search(r'error TS\d+', stripped):
            out.append(stripped)
        elif re.search(r'warning TS\d+', stripped):
            out.append(stripped)
        # Summary line: "Found N error(s)."
        elif re.search(r'Found \d+ error', stripped):
            out.append(stripped)
        # Clean compile
        elif 'no errors' in stripped.lower():
            out.append(stripped)
    if not out:
        # Nothing matched — might be a pass with no output
        summary = [l.rstrip() for l in lines if l.strip()]
        return summary[-3:] if summary else ['(no output)']
    return out


def compress_pytest(lines: list[str]) -> list[str]:
    """Keep FAILED lines, assertion errors, and the short summary section."""
    out = []
    in_short_summary = False
    in_failure_block = False

    for line in lines:
        stripped = line.rstrip()
        # Short test summary section at the end
        if re.match(r'=+ short test summary', stripped, re.IGNORECASE):
            in_short_summary = True
        if in_short_summary:
            out.append(stripped)
            continue
        # Failure block headers
        if re.match(r'_{3,}.*FAILED.*_{3,}', stripped) or re.match(r'FAILED ', stripped):
            in_failure_block = True
            out.append(stripped)
            continue
        if in_failure_block:
            # AssertionError lines and E-prefixed lines
            if re.match(r'\s*E\s+', stripped) or 'AssertionError' in stripped:
                out.append(stripped)
            # End of failure block
            elif re.match(r'={3,}', stripped):
                out.append(stripped)
                in_failure_block = False
        # Top-level FAILED / PASSED summary
        if re.match(r'(FAILED|PASSED|ERROR)\s+', stripped):
            out.append(stripped)
        # Final summary line
        if re.search(r'\d+ (failed|passed|error)', stripped):
            out.append(stripped)

    return out if out else lines[-10:]


def compress_npm_test(lines: list[str]) -> list[str]:
    """Keep failing test names, error messages, and summary."""
    out = []
    for line in lines:
        stripped = line.rstrip()
        # Vitest / Jest failure markers
        if re.search(r'(FAIL|✗|✘|×)\s+', stripped):
            out.append(stripped)
        elif re.search(r'(FAILED|AssertionError|expect\(|Error:)', stripped):
            out.append(stripped)
        # Summary: X passed, Y failed
        elif re.search(r'\d+ (passed|failed|skipped)', stripped.lower()):
            out.append(stripped)
        # Stack trace first line only
        elif re.match(r'\s+at ', stripped) and (not out or not re.match(r'\s+at ', out[-1])):
            out.append(stripped + '  ...')
    return out if out else lines[-10:]


def compress_cargo_test(lines: list[str]) -> list[str]:
    """Keep FAILED lines and the summary."""
    out = []
    for line in lines:
        stripped = line.rstrip()
        if re.search(r'^test .+ \.\.\. FAILED', stripped):
            out.append(stripped)
        elif re.search(r'^FAILED', stripped):
            out.append(stripped)
        elif re.search(r'test result:', stripped):
            out.append(stripped)
        elif re.search(r'thread .+ panicked', stripped):
            out.append(stripped)
    return out if out else lines[-5:]


def compress_go_test(lines: list[str]) -> list[str]:
    out = []
    for line in lines:
        stripped = line.rstrip()
        if re.search(r'^--- FAIL', stripped):
            out.append(stripped)
        elif re.search(r'^FAIL\s', stripped):
            out.append(stripped)
        elif re.search(r'panic:', stripped):
            out.append(stripped)
    return out if out else lines[-5:]


def compress_git_diff(lines: list[str]) -> list[str]:
    """Keep file headers and +/- lines. Drop context lines if output is huge."""
    out = []
    for line in lines:
        stripped = line.rstrip()
        # File header
        if stripped.startswith('diff --git') or stripped.startswith('+++') or stripped.startswith('---'):
            out.append(stripped)
        # Hunk header
        elif stripped.startswith('@@'):
            out.append(stripped)
        # Added/removed lines
        elif stripped.startswith('+') or stripped.startswith('-'):
            # Skip whitespace-only changes
            if stripped[1:].strip():
                out.append(stripped)
        # Skip binary diff noise
        elif stripped.startswith('Binary'):
            out.append(stripped)
    return out if out else lines


def compress_generic(lines: list[str]) -> list[str]:
    """Deduplicate consecutive identical lines with count, then truncate."""
    deduped = []
    prev = None
    count = 0
    for line in lines:
        stripped = line.rstrip()
        if stripped == prev:
            count += 1
        else:
            if prev is not None:
                if count > 1:
                    deduped.append(f'{prev}  [×{count + 1}]')
                else:
                    deduped.append(prev)
            prev = stripped
            count = 0
    if prev is not None:
        deduped.append(prev if count == 0 else f'{prev}  [×{count + 1}]')

    if len(deduped) > MAX_LINES:
        head = deduped[:MAX_LINES // 2]
        tail = deduped[-(MAX_LINES // 2):]
        omitted = len(deduped) - MAX_LINES
        return head + [f'... [{omitted} lines omitted] ...'] + tail
    return deduped


# ---------------------------------------------------------------------------
# Main compression dispatcher
# ---------------------------------------------------------------------------

def compress(output: str, output_type: str) -> tuple[str, int, int]:
    """
    Returns (compressed_text, original_line_count, compressed_line_count).
    Passes through unchanged if under threshold.
    """
    lines = output.splitlines()
    original = len(lines)

    if original <= LINE_THRESHOLD:
        return output, original, original

    if output_type == 'tsc':
        compressed = compress_tsc(lines)
    elif output_type == 'pytest':
        compressed = compress_pytest(lines)
    elif output_type == 'npm_test':
        compressed = compress_npm_test(lines)
    elif output_type == 'cargo_test':
        compressed = compress_cargo_test(lines)
    elif output_type == 'go_test':
        compressed = compress_go_test(lines)
    elif output_type == 'git_diff':
        compressed = compress_git_diff(lines)
    else:
        compressed = compress_generic(lines)

    # Safety cap
    if len(compressed) > MAX_LINES:
        compressed = compressed[:MAX_LINES] + [f'... [{len(compressed) - MAX_LINES} lines omitted] ...']

    text = '\n'.join(compressed)
    if original > len(compressed):
        text += f'\n\n[helots-compress: {original} → {len(compressed)} lines ({100 - round(len(compressed)/original*100)}% reduction)]'

    return text, original, len(compressed)


# ---------------------------------------------------------------------------
# Mode: CLI wrapper  --run "command"
# ---------------------------------------------------------------------------

def run_mode(command: str):
    output_type = detect_type(command)
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    raw = result.stdout + result.stderr
    compressed, orig, comp = compress(raw, output_type)
    sys.stdout.write(compressed)
    if result.returncode != 0:
        sys.exit(result.returncode)


# ---------------------------------------------------------------------------
# Mode: PostToolUse hook  --hook
# ---------------------------------------------------------------------------

def hook_mode():
    data = json.load(sys.stdin)
    tool_name = data.get('tool_name', '')
    tool_response = data.get('tool_response', {})

    # Only compress helots MCP tools (slinger/run/hoplite)
    if not tool_name.startswith('mcp__helots__'):
        sys.exit(0)

    # Extract text content from MCP tool response
    raw = ''
    if isinstance(tool_response, str):
        raw = tool_response
    elif isinstance(tool_response, dict):
        # MCP responses are typically {"content": [{"type": "text", "text": "..."}]}
        content = tool_response.get('content', [])
        if isinstance(content, list):
            raw = '\n'.join(
                block.get('text', '') for block in content
                if isinstance(block, dict) and block.get('type') == 'text'
            )
        elif isinstance(content, str):
            raw = content

    if not raw:
        sys.exit(0)

    lines = raw.splitlines()
    if len(lines) <= LINE_THRESHOLD:
        sys.exit(0)

    compressed, orig, comp = compress(raw, 'generic')

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "updatedMCPToolOutput": compressed,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    if '--hook' in sys.argv:
        hook_mode()
    elif '--run' in sys.argv:
        idx = sys.argv.index('--run')
        if idx + 1 >= len(sys.argv):
            print('Usage: helots-compress.py --run "command string"', file=sys.stderr)
            sys.exit(1)
        run_mode(sys.argv[idx + 1])
    else:
        # Stdin pipe mode: reads raw text, type from --type flag
        output_type = 'generic'
        if '--type' in sys.argv:
            idx = sys.argv.index('--type')
            if idx + 1 < len(sys.argv):
                output_type = sys.argv[idx + 1]
        raw = sys.stdin.read()
        compressed, _, _ = compress(raw, output_type)
        sys.stdout.write(compressed)
