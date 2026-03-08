#!/usr/bin/env python3
"""
helots-lsp-search.py — PreToolUse hook: suggest LSP for symbol lookups.

Fires before Grep/Bash when the search looks like a definition or reference lookup.
LSP plugins (typescript-lsp, pyright-lsp, rust-lsp) are active and give exact
file:line results without reading whole files.

Silent when the search looks like a content/pattern search rather than symbol resolution.
"""

import json
import re
import sys


# Grep patterns that suggest a symbol definition/reference lookup
SYMBOL_NAME_RE = re.compile(r'^[\w$][\w$]{2,}$')  # plain word, no regex operators

# Bash grep commands targeting function/class definitions
DEFINITION_GREP_RE = re.compile(
    r'grep.*["\'].*(?:function\b|class\b|\bdef\b|export\b|import\b)',
    re.IGNORECASE,
)


def is_symbol_grep(pattern: str) -> bool:
    """Plain word with no regex special chars — likely a symbol name lookup."""
    if not pattern:
        return False
    # Skip if it contains regex operators (content search, not symbol)
    if any(c in pattern for c in r'.*+?[]{}()|^$\n\t\s'):
        return False
    return bool(SYMBOL_NAME_RE.match(pattern.strip()))


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_name = data.get('tool_name', '')
    tool_input = data.get('tool_input', {})

    triggered = False

    if tool_name == 'Grep':
        pattern = tool_input.get('pattern', '')
        if is_symbol_grep(pattern):
            triggered = True

    elif tool_name == 'Bash':
        cmd = tool_input.get('command', '')
        if DEFINITION_GREP_RE.search(cmd):
            triggered = True

    if not triggered:
        sys.exit(0)

    out = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'additionalContext': (
                '[helots-lsp] LSP plugins are active (typescript-lsp, pyright-lsp, rust-lsp). '
                'For symbol lookup use LSP tools first — they give exact file:line, type info, '
                'and find-all-references without reading whole files. '
                'Grep after LSP only if you need content context around the match.'
            ),
        }
    }
    print(json.dumps(out))
    sys.exit(0)


if __name__ == '__main__':
    main()
