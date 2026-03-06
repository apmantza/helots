#!/usr/bin/env python3
"""
helots-autocommit.py — Auto-commit on Stop using last user prompt as message.

Flow:
  1. Read JSON from stdin (Stop hook input)
  2. Pull transcript_path and cwd (project directory)
  3. Parse JSONL to find the last user prompt
  4. Write prompt text to a temp file
  5. git add -u  (tracked files only — safe for auto-commit)
  6. git commit -F <tempfile>  (skips if nothing staged)
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled


def extract_text_from_content(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'text':
                parts.append(block.get('text', ''))
        return ' '.join(p for p in parts if p.strip()).strip()
    return ''


def find_last_user_prompt(transcript_path: str) -> str | None:
    path = pathlib.Path(transcript_path)
    if not path.exists():
        return None

    last_prompt = None
    try:
        with path.open('r', encoding='utf-8', errors='replace') as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if event.get('type') != 'user':
                    continue

                msg = event.get('message', {})
                if not isinstance(msg, dict):
                    continue
                if msg.get('role') != 'user':
                    continue

                text = extract_text_from_content(msg.get('content', ''))
                if text:
                    last_prompt = text
    except Exception:
        pass

    return last_prompt


def run(cmd: list[str], cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
    )


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    transcript_path = data.get('transcript_path', '')
    cwd = data.get('cwd', '')

    if not is_enabled('helots-autocommit', cwd):
        sys.exit(0)

    if not transcript_path or not cwd:
        sys.exit(0)

    # Must be a git repo
    result = run(['git', 'rev-parse', '--is-inside-work-tree'], cwd)
    if result.returncode != 0:
        sys.exit(0)

    # Find last user prompt for commit message
    prompt = find_last_user_prompt(transcript_path)
    if not prompt:
        sys.exit(0)

    # Stage tracked modified files only
    run(['git', 'add', '-u'], cwd)

    # Check if anything is staged
    staged = run(['git', 'diff', '--cached', '--quiet'], cwd)
    if staged.returncode == 0:
        # Nothing staged — nothing to commit
        sys.exit(0)

    # Build commit message: first line capped at 72 chars, full prompt in body
    first_line = prompt[:72]
    if len(prompt) > 72:
        body = f'\n\n{prompt}'
        message = f'[helots] {first_line}...{body}'
    else:
        message = f'[helots] {first_line}'

    # Write to temp file and commit
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False, encoding='utf-8') as tf:
        tf.write(message)
        tf_path = tf.name

    try:
        run(['git', 'commit', '-F', tf_path], cwd)
    finally:
        os.unlink(tf_path)

    sys.exit(0)


if __name__ == '__main__':
    main()
