#!/usr/bin/env python3
"""
hooks/install.py — Wire helots hooks into ~/.claude/settings.json

Run once after cloning or moving the project:
    python3 hooks/install.py

Backs up settings.json before modifying. Safe to re-run.
"""

import json
import pathlib
import shutil
import sys
from datetime import datetime

HOOKS_DIR = pathlib.Path(__file__).parent.resolve()
SETTINGS_PATH = pathlib.Path.home() / ".claude" / "settings.json"


def cmd(script: str, *flags: str) -> str:
    path = (HOOKS_DIR / script).as_posix()
    parts = ["python3", path] + list(flags)
    return " ".join(parts)


HOOKS_CONFIG = {
    "PreToolUse": [
        {
            "matcher": ".*",
            "hooks": [{"type": "command", "command": cmd("helots-delegate.py")}],
        },
        {
            "matcher": "mcp__helots__helot_run",
            "hooks": [{"type": "command", "command": cmd("helots-run-validate.py")}],
        },
        {
            "matcher": "Write|Edit",
            "hooks": [{"type": "command", "command": cmd("helots-filesize.py")}],
        },
    ],
    "SessionStart": [
        {
            "hooks": [{"type": "command", "command": cmd("helots-session-start.py")}],
        }
    ],
    "PostToolUseFailure": [
        {
            "matcher": ".*",
            "hooks": [{"type": "command", "command": cmd("helots-error-handler.py")}],
        }
    ],
    "PostToolUse": [
        {
            "matcher": "mcp__helots__.*",
            "hooks": [{"type": "command", "command": cmd("helots-compress.py", "--hook")}],
        },
        {
            "matcher": "mcp__helots__helot_run",
            "hooks": [{"type": "command", "command": cmd("helots-test-runner.py")}],
        },
        {
            "matcher": "Edit|Write|NotebookEdit",
            "hooks": [
                {"type": "command", "command": cmd("helots-format.py")},
                {"type": "command", "command": cmd("helots-gitstage.py"), "async": True},
            ],
        },
    ],
    "Stop": [
        {
            "hooks": [
                {"type": "command", "command": cmd("helots-autocommit.py")},
                {
                    "type": "command",
                    "command": cmd("helots-session-summary.py"),
                    "async": True,
                },
            ],
        }
    ],
    "PreCompact": [
        {
            "hooks": [{"type": "command", "command": cmd("helots-session-summary.py")}],
        }
    ],
}


def main() -> None:
    # Load or init settings
    if SETTINGS_PATH.exists():
        backup = SETTINGS_PATH.with_suffix(
            f".{datetime.now().strftime('%Y%m%d-%H%M%S')}.bak"
        )
        shutil.copy2(SETTINGS_PATH, backup)
        print(f"Backup:  {backup}")
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    else:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        settings = {}

    settings["hooks"] = HOOKS_CONFIG
    SETTINGS_PATH.write_text(
        json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Updated: {SETTINGS_PATH}")
    print(f"Hooks:   {HOOKS_DIR}")
    print()
    print("Done. Restart Claude Code for changes to take effect.")


if __name__ == "__main__":
    main()
