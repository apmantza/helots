"""
helots-common.py — Shared utilities for all helots hooks.

Import pattern in each hook:
    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    from helots_common import is_enabled
"""

import json
import pathlib


def is_enabled(hook_name: str, cwd: str) -> bool:
    """
    Check if a hook is enabled for the current project.

    Reads .claude/hooks.json in the project root (cwd).
    If the file doesn't exist, all hooks are enabled by default.

    Format:
        {
          "disabled": ["helots-autocommit", "helots-format"]
        }

    Returns True if the hook should run, False if it should skip.
    """
    if not cwd:
        return True

    config_path = pathlib.Path(cwd) / '.claude' / 'hooks.json'
    if not config_path.exists():
        return True

    try:
        data = json.loads(config_path.read_text(encoding='utf-8'))
        disabled = data.get('disabled', [])
        return hook_name not in disabled
    except Exception:
        return True  # fail open
