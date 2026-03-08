#!/usr/bin/env python3
"""
helots-slinger-outputfile.py — PreToolUse hook: remind Claude to set outputFile on helot_slinger.

Fires before mcp__helots__helot_slinger calls.
If outputFile is absent or empty, injects a prescriptive reminder so the full
slinger report is written to disk and only a compact summary hits frontier context.
Silent when outputFile is already set.
"""

import json
import sys


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get('tool_input', {})

    # Already set — nothing to do
    if tool_input.get('outputFile', '').strip():
        sys.exit(0)

    out = {
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'additionalContext': (
                '[helots-slinger-outputfile] outputFile is not set. '
                'Add outputFile: ".helot-mcp-connector/research.md" to this slinger call — '
                'this writes the full report to disk and returns only a compact summary to frontier, '
                'saving thousands of context tokens. '
                'Also: if you need exact code lines for an upcoming Edit, add a '
                'READLINES <file> <start>-<end> question to the research task so slinger '
                'fetches them verbatim in the same round-trip.'
            ),
        }
    }
    print(json.dumps(out))
    sys.exit(0)


if __name__ == '__main__':
    main()
