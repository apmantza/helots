#!/usr/bin/env python3
"""
helots-error-handler.py — PostToolUseFailure hook: inject targeted debugging hints.

Fires after any tool call fails. Pattern-matches the error and injects
a structured additionalContext nudge so Claude debugs systematically
rather than guessing.

Toggle: add "helots-error-handler" to .claude/hooks.json "disabled" list.
"""

import json
import re
import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled


# ── Error patterns ────────────────────────────────────────────────────────────

PATTERNS = [
    (
        r'(ENOENT|no such file|not found|cannot find)',
        "Path not found. Verify the exact path with Glob before retrying. "
        "Do not guess paths — use helot_slinger if you need to locate the file."
    ),
    (
        r'(EACCES|EPERM|permission denied|access denied)',
        "Permission error. Check if the file is read-only or locked by another process. "
        "On Windows, check if the file is open in another application."
    ),
    (
        r'(command not found|is not recognized|not recognized as|Cannot find module)',
        "Command or module not found. Check if the dependency is installed "
        "and available in PATH. Run the install command before retrying."
    ),
    (
        r'(ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|failed to fetch)',
        "Network/connection error. Check if the target service is running "
        "(e.g. local LLM server, dev server). Do not retry in a loop — diagnose first."
    ),
    (
        r'(SyntaxError|unexpected token|ParseError|parse error)',
        "Syntax error in the file or command. Read the file to verify the syntax "
        "before retrying. Do not blindly re-run — fix the root cause first."
    ),
    (
        r'(git|fatal:.*git)',
        "Git error. Check git status and the working tree state before retrying. "
        "If there are merge conflicts or lock files, resolve them first."
    ),
    (
        r'(TypeScript|TS\d{4}|tsc)',
        "TypeScript error. Run tsc to see the full error list. "
        "Fix type errors before retrying the operation."
    ),
    (
        r'(timeout|timed out)',
        "Operation timed out. Check if the target process is responsive. "
        "Do not retry immediately — investigate the cause first."
    ),
    (
        r'(ENOSPC|no space left|disk full)',
        "Disk space error. Free up space before retrying. "
        "Check large files or build artifacts that can be cleaned."
    ),
]


def classify_error(error_text: str) -> str | None:
    error_lower = error_text.lower()
    for pattern, hint in PATTERNS:
        if re.search(pattern, error_lower, re.IGNORECASE):
            return hint
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    cwd = data.get('cwd', '')
    if not is_enabled('helots-error-handler', cwd):
        sys.exit(0)

    tool_name = data.get('tool_name', '')
    tool_response = data.get('tool_response', {})

    # Extract error text from tool response
    error_text = ''
    if isinstance(tool_response, str):
        error_text = tool_response
    elif isinstance(tool_response, dict):
        error_text = (
            tool_response.get('error', '')
            or tool_response.get('message', '')
            or str(tool_response)
        )

    if not error_text:
        sys.exit(0)

    hint = classify_error(error_text)
    if not hint:
        # Generic fallback for unrecognised errors
        hint = (
            "Diagnose the root cause before retrying. "
            "Do not loop on the same failing call — try a different approach or ask for help."
        )

    context = f"[helots-error] Tool '{tool_name}' failed. {hint}"

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUseFailure",
            "additionalContext": context,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == '__main__':
    main()
