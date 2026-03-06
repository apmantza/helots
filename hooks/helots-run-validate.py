#!/usr/bin/env python3
"""
helots-run-validate.py — PreToolUse hook: validate helot_run task structure.

Fires before mcp__helots__helot_run calls.
Checks task structure against the hard rules in the helots skill:
  - Non-CREATE tasks must have a `symbol`
  - `changes` must be substantive (not vague)
  - `dependsOn` must only reference valid task IDs
  - At least one task must be present

Injects additionalContext warnings — never blocks.
"""

import json
import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled


MIN_CHANGES_LENGTH = 40  # chars — below this is likely too vague


def validate_tasks(tasks: list) -> list[str]:
    warnings = []

    if not tasks:
        warnings.append("No tasks provided — helot_run will do nothing.")
        return warnings

    task_ids = {str(t.get('id', '')) for t in tasks if isinstance(t, dict)}

    for t in tasks:
        if not isinstance(t, dict):
            continue

        tid = str(t.get('id', '?'))
        description = t.get('description', '')
        symbol = t.get('symbol', '')
        changes = t.get('changes', '')
        depends_on = t.get('dependsOn', [])

        # Non-CREATE tasks should have a symbol
        is_create = 'create' in description.lower() or not symbol
        if not symbol and not is_create:
            warnings.append(
                f"Task {tid} ('{description[:40]}'): missing `symbol`. "
                f"Builder needs exact function/class name. Omit only for CREATE tasks."
            )

        # Changes must be substantive
        if len(changes.strip()) < MIN_CHANGES_LENGTH:
            warnings.append(
                f"Task {tid}: `changes` is too short ({len(changes.strip())} chars). "
                f"Must show exact old→new lines, not vague instructions."
            )

        # dependsOn must reference valid IDs
        for dep in depends_on:
            if str(dep) not in task_ids:
                warnings.append(
                    f"Task {tid}: `dependsOn` references unknown task ID '{dep}'. "
                    f"Check task IDs are consistent."
                )

    return warnings


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    cwd = data.get('cwd', '')
    if not is_enabled('helots-run-validate', cwd):
        sys.exit(0)

    tool_input = data.get('tool_input', {})
    tasks = tool_input.get('tasks', [])

    warnings = validate_tasks(tasks)
    if not warnings:
        sys.exit(0)

    context = (
        "[helots-run-validate] Task structure warnings — fix before proceeding:\n"
        + '\n'.join(f'  • {w}' for w in warnings)
    )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "additionalContext": context,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == '__main__':
    main()
