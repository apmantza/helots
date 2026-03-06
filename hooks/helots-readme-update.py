#!/usr/bin/env python3
"""
helots-readme-update.py — Auto-update README before context compaction.

Fires on: PreCompact

Flow:
  1. Read docs/project-structure.md (if exists) + current README.md
  2. Read recent git log (last 10 commits) for change context
  3. Call local LLM to update README with any stale sections
  4. Write README.md in place

LLM endpoint: env HELOT_LLM_URL or http://127.0.0.1:8081
"""

import json
import os
import pathlib
import subprocess
import sys
import urllib.request
import urllib.error

LLM_URL   = os.environ.get('HELOT_LLM_URL', 'http://127.0.0.1:8081')
MAX_TOKENS = 2048
MODEL      = os.environ.get('HELOT_DENSE_MODEL', 'qwen27b')


def call_llm(prompt: str) -> str:
    payload = json.dumps({
        'model': MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': MAX_TOKENS,
        'temperature': 0.2,
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{LLM_URL}/v1/chat/completions',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data['choices'][0]['message']['content'].strip()
    except Exception as e:
        return f'[README update failed: {e}]'


def read_file(path: str) -> str:
    try:
        return pathlib.Path(path).read_text(encoding='utf-8')
    except Exception:
        return ''


def git_log(cwd: str) -> str:
    try:
        result = subprocess.run(
            ['git', 'log', '--oneline', '-10'],
            cwd=cwd, capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip()
    except Exception:
        return ''


def main():
    data = json.load(sys.stdin)
    hook_event = data.get('hook_event_name', '')
    if hook_event != 'PreCompact':
        sys.exit(0)

    cwd = data.get('cwd', os.getcwd())

    readme_path      = pathlib.Path(cwd) / 'README.md'
    structure_path   = pathlib.Path(cwd) / 'docs' / 'project-structure.md'

    readme    = read_file(str(readme_path))
    structure = read_file(str(structure_path))
    log       = git_log(cwd)

    if not readme:
        sys.exit(0)  # nothing to update

    structure_section = f"""## Current project structure (docs/project-structure.md):
{structure[:3000]}
""" if structure else ''

    prompt = f"""You are updating a project README to keep it accurate.

## Current README.md:
{readme[:3000]}

{structure_section}
## Recent git commits:
{log}

## Task:
Update the README so it accurately reflects the current project state.
- Keep the existing tone, format, and section headings
- Only change sections that are clearly stale or inaccurate based on the structure doc and git log
- Do not add new sections unless something important is completely missing
- Do not remove sections that are still accurate
- Return the complete updated README.md content only — no preamble, no explanation

Updated README.md:"""

    updated = call_llm(prompt)

    if updated and not updated.startswith('[README update failed'):
        readme_path.write_text(updated, encoding='utf-8')

    # Non-blocking — never fail the compaction
    sys.exit(0)


if __name__ == '__main__':
    main()
