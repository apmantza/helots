#!/usr/bin/env python3
"""
helots-session-summary.py — Automatic session summarization hook.

Fires on:
  - Stop     : every TURNS_BETWEEN_SUMMARIES turns (async, non-blocking)
  - PreCompact: always — persist discoveries before context is compressed

Flow:
  1. Read session JSONL delta since last summary (position-tracked per session)
  2. Strip tool inputs/outputs — keep only message text + tool names
  3. Call local LLM to extract memory-worthy discoveries
  4. Append dated summary block to project MEMORY.md
  5. Update position tracker

State file: ~/.claude/helots-session-state.json
  { "<session_id>": { "last_line": 42, "turns": 3, "ts": "..." } }

MEMORY.md location: derived from transcript_path
  ~/.claude/projects/<hash>/memory/MEMORY.md

LLM endpoint: env HELOT_LLM_URL or http://127.0.0.1:8081
"""

import json
import os
import pathlib
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled

# ── Config ──────────────────────────────────────────────────────────────────
TURNS_BETWEEN_SUMMARIES = 10   # Stop hook: only summarize every N turns
MIN_DELTA_TURNS = 3            # Skip if fewer than this many assistant turns in delta
MAX_DELTA_CHARS = 24_000       # Soft cap on delta fed to LLM (~6k tokens)
MAX_SUMMARY_TOKENS = 450
LLM_URL = os.environ.get('HELOT_LLM_URL', 'http://127.0.0.1:8081')
LLM_MODEL = os.environ.get('HELOT_MODEL', 'qwen27b')
STATE_FILE = pathlib.Path.home() / '.claude' / 'helots-session-state.json'


# ── State management ─────────────────────────────────────────────────────────

def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    except Exception:
        return {}


def save_state(state: dict):
    try:
        STATE_FILE.write_text(json.dumps(state, indent=2))
    except Exception:
        pass


# ── JSONL parsing ─────────────────────────────────────────────────────────────

def extract_text_from_content(content) -> str:
    """Extract plain text from a content block or list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get('type', '')
            if btype == 'text':
                parts.append(block.get('text', ''))
            elif btype == 'tool_use':
                # Keep tool name only, drop inputs
                parts.append(f'[tool: {block.get("name", "?")}]')
            # thinking, tool_result blocks dropped entirely
        return ' '.join(p for p in parts if p.strip())
    return ''


def read_delta(transcript_path: str, last_line: int) -> tuple[list[dict], int]:
    """
    Read JSONL from last_line onwards.
    Returns (list of {role, text} dicts, new_last_line).

    Actual Claude Code JSONL format (confirmed from session file):
      - type: "user"      → message.role="user",      message.content=[...]
      - type: "assistant" → message.role="assistant",  message.content=[...]
      - type: "system" / "progress" / "file-history-snapshot" → skip
    """
    path = pathlib.Path(transcript_path)
    if not path.exists():
        return [], last_line

    messages = []
    current_line = 0
    SKIP_TYPES = {'system', 'progress', 'file-history-snapshot'}

    try:
        with path.open('r', encoding='utf-8', errors='replace') as f:
            for raw in f:
                current_line += 1
                if current_line <= last_line:
                    continue
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                etype = event.get('type', '')
                if etype in SKIP_TYPES:
                    continue

                # Primary format: type="user"|"assistant", message={role, content}
                msg = event.get('message')
                if isinstance(msg, dict):
                    role = msg.get('role', '')
                    content = msg.get('content', '')
                    if role in ('user', 'assistant'):
                        text = extract_text_from_content(content)
                        if text.strip():
                            messages.append({'role': role, 'text': text.strip()})

    except Exception:
        pass

    return messages, current_line


def build_delta_text(messages: list[dict]) -> str:
    """Format messages into compact text for LLM summarization."""
    lines = []
    for m in messages:
        role = m['role'].upper()[:10]
        text = m['text']
        # Truncate very long individual messages
        if len(text) > 1200:
            text = text[:1200] + '...[truncated]'
        lines.append(f'[{role}]: {text}')
    return '\n\n'.join(lines)


# ── LLM call ─────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a session memory extractor for a software development AI assistant.
You will receive a transcript excerpt from a Claude Code session working on the helots-pi project.
Extract only facts worth persisting across sessions: confirmed behaviors, discovered capabilities,
architectural decisions, bug fixes, patterns, and workflow insights.
Ignore small talk, task status, and anything already obvious from the code.
Be concise. Use bullet points. 3-8 bullets maximum."""

USER_TEMPLATE = """Session transcript excerpt:

{delta}

---
Write a compact memory block (3-8 bullets) capturing what is worth remembering from this excerpt.
Start directly with the bullets, no preamble."""


def call_llm(delta_text: str) -> str | None:
    payload = {
        'model': LLM_MODEL,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': USER_TEMPLATE.format(delta=delta_text)},
        ],
        'max_tokens': MAX_SUMMARY_TOKENS,
        'temperature': 0.3,
        'stream': False,
    }
    try:
        req = urllib.request.Request(
            f'{LLM_URL}/v1/chat/completions',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data['choices'][0]['message']['content'].strip()
    except Exception as e:
        return None


# ── MEMORY.md append ──────────────────────────────────────────────────────────

def derive_memory_path(transcript_path: str) -> pathlib.Path | None:
    """
    Derive MEMORY.md path from transcript path.
    transcript: ~/.claude/projects/<hash>/<session>.jsonl
    memory:     ~/.claude/projects/<hash>/memory/MEMORY.md
    """
    t = pathlib.Path(transcript_path)
    project_dir = t.parent
    memory_path = project_dir / 'memory' / 'MEMORY.md'
    return memory_path if memory_path.exists() else None


def append_summary(memory_path: pathlib.Path, summary: str, trigger: str):
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    block = f'\n\n## Auto-Summary [{ts}] ({trigger})\n\n{summary}\n'
    try:
        with memory_path.open('a', encoding='utf-8') as f:
            f.write(block)
    except Exception:
        pass


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    hook_event = data.get('hook_event_name', '')
    session_id = data.get('session_id', 'unknown')
    transcript_path = data.get('transcript_path', '')
    cwd = data.get('cwd', '')

    if not is_enabled('helots-session-summary', cwd):
        sys.exit(0)

    if not transcript_path:
        sys.exit(0)

    state = load_state()
    session_state = state.get(session_id, {'last_line': 0, 'turns': 0})

    # Stop hook: increment turn counter, skip if under threshold
    if hook_event == 'Stop':
        session_state['turns'] = session_state.get('turns', 0) + 1
        if session_state['turns'] < TURNS_BETWEEN_SUMMARIES:
            state[session_id] = session_state
            save_state(state)
            sys.exit(0)
        # Reset counter
        session_state['turns'] = 0

    # PreCompact: always run regardless of turn count
    # (session_state['turns'] left as-is)

    # Read delta
    messages, new_last_line = read_delta(transcript_path, session_state.get('last_line', 0))

    # Count assistant turns in delta as a proxy for meaningful content
    assistant_turns = sum(1 for m in messages if m['role'] == 'assistant')
    if assistant_turns < MIN_DELTA_TURNS:
        state[session_id] = {**session_state, 'last_line': new_last_line}
        save_state(state)
        sys.exit(0)

    # Build and cap delta text
    delta_text = build_delta_text(messages)
    if len(delta_text) > MAX_DELTA_CHARS:
        delta_text = delta_text[-MAX_DELTA_CHARS:]  # keep most recent portion

    # Call LLM
    summary = call_llm(delta_text)
    if not summary:
        # LLM unavailable — update line position anyway to avoid re-processing
        state[session_id] = {**session_state, 'last_line': new_last_line}
        save_state(state)
        sys.exit(0)

    # Append to MEMORY.md
    memory_path = derive_memory_path(transcript_path)
    if memory_path:
        trigger = 'pre-compact' if hook_event == 'PreCompact' else f'stop/{TURNS_BETWEEN_SUMMARIES}turns'
        append_summary(memory_path, summary, trigger)

    # Update state
    state[session_id] = {
        **session_state,
        'last_line': new_last_line,
        'last_ts': datetime.now(timezone.utc).isoformat(),
    }
    save_state(state)
    sys.exit(0)


if __name__ == '__main__':
    main()
