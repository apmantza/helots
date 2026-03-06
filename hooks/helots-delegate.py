#!/usr/bin/env python3
"""
Helots PreToolUse Hook

When helots MCP is connected, reminds Claude to delegate:
  - Grep/Glob broad searches → helot_slinger
  - Read with offset (section browsing) → helot_slinger
  - Read on large files (>6KB) for analysis → helot_slinger
  - Read on .md files → helot_hoplite (it reads+writes locally, zero frontier cost for file content)
  - Bash verbose git commands (diff/log/show) → helot_slinger
  - Edit/Write on .md files → helot_hoplite
  - Edit/Write multi-file work → helot_run
  - Bash loop reading multiple files (for/head/cat patterns) → helot_slinger
  - WebFetch of large/doc URLs → helot_hoplite (fetch + summarize → temp .md file, keeps full
    doc content off frontier context entirely; only the extracted summary hits Claude's context)

Key principle: delegating Read to slinger only saves tokens when slinger SUMMARIZES.
If you need the full file content, use Read directly. If the intent is to edit a .md
file, skip Read entirely and go straight to helot_hoplite — it handles read+write
internally with no frontier token cost for the file content.

helot_hoplite WebFetch pattern:
  - Ask hoplite to fetch a URL and write a targeted summary to a temp .md file
  - Then Read only the summary (small) rather than the full page (large)
  - slinger does NOT have WebFetch — hoplite is the only helot that can fetch URLs

Fires only when the operation looks like it warrants delegation.
Never blocks — only injects additionalContext (exit 0).
"""
import json
import os
import sys

data = json.load(sys.stdin)
tool_name = data.get('tool_name', '')
tool_input = data.get('tool_input', {})

reminder = None

if tool_name == 'Bash':
    command = tool_input.get('command', '')
    cmd = command.strip()
    # Verbose git commands produce large output that bloats context
    VERBOSE_GIT = ('git diff', 'git log', 'git show', 'git shortlog')
    # Build/test commands produce verbose output; compress via wrapper
    BUILD_CMDS = ('npx tsc', 'tsc ', 'npm test', 'npm run test', 'pytest', 'python -m pytest',
                  'cargo test', 'go test', 'vitest', 'jest')
    if any(cmd.startswith(v) for v in VERBOSE_GIT):
        reminder = (
            "helots MCP is connected. This git command produces verbose output that will bloat context — "
            "use helot_slinger instead (git is now in the allowlist). "
            "Ask slinger to run the command and return a compact summary."
        )
    elif any(cmd.startswith(v) for v in BUILD_CMDS):
        hooks_dir = os.path.dirname(os.path.abspath(__file__))
        compress = os.path.join(hooks_dir, 'helots-compress.py')
        reminder = (
            f"helots compression is available. This build/test command can produce hundreds of lines. "
            f"Run it through the compressor instead to save frontier tokens:\n"
            f"  python3 {compress} --run \"{cmd}\"\n"
            f"The compressor returns failures only (90% reduction on typical test output). "
            f"Only use the raw command if you need the full unfiltered output."
        )
    # Bash loop reading multiple files (for/while + head/cat/tail) is a multi-file research
    # pattern — slinger handles it in one shot with zero frontier token cost for file content
    elif any(kw in cmd for kw in ('for f in', 'for file in', 'while read')) and \
            any(kw in cmd for kw in ('head ', 'cat ', 'tail ', 'sed ')):
        reminder = (
            "helots MCP is connected. This Bash loop reads multiple files — "
            "a research pattern that wastes frontier tokens. Use helot_slinger instead: "
            "describe what you need to understand across those files and let slinger summarize. "
            "Direct Bash file-reading loops should only be used when you need raw output for a shell pipeline."
        )

elif tool_name == 'mcp__helots__helot_slinger':
    task = tool_input.get('researchTask', '')
    WRITE_HINTS = ('write to', 'write it to', 'output to', 'save to', 'generate', 'create a doc', 'update doc', '.md', 'structure.md')
    if any(h in task.lower() for h in WRITE_HINTS):
        reminder = (
            "helots MCP is connected. This slinger task looks like it ends in a file write — "
            "use helot_slinger with outputFile instead (one call: slinger research → hoplite write, result never hits frontier)."
        )

elif tool_name == 'Grep':
    path = tool_input.get('path', '')
    # Broad search: no path (searches CWD = directory) or path is explicitly a directory
    if not path or os.path.isdir(path):
        reminder = (
            "helots MCP is connected. This Grep searches a directory — "
            "if this is research across multiple files, use helot_slinger instead "
            "to preserve context window. Direct Grep is only appropriate for a "
            "single targeted lookup on a known file path."
        )

elif tool_name in ('Edit', 'Write'):
    file_path = tool_input.get('file_path', '')
    if file_path.endswith('.md'):
        reminder = (
            "helots MCP is connected. This edits a markdown file — "
            "use helot_hoplite instead to preserve context window. "
            "helot_hoplite reads + writes the file locally with no peltast overhead. "
            "NOTE: helot_hoplite is for docs/config only — never use it on code files."
        )

elif tool_name == 'Read':
    file_path = tool_input.get('file_path', '')
    offset = tool_input.get('offset')
    if file_path.endswith('.md'):
        reminder = (
            "helots MCP is connected. You are reading a markdown file. "
            "If the intent is to edit it afterward, skip this Read and go straight to helot_hoplite — "
            "it reads + writes the file locally with zero frontier token cost for the file content. "
            "Only use Read on .md files if you genuinely need the content in your own context (e.g. to answer a question)."
        )
    elif offset is not None:
        # Reading a section (offset set) is a navigation/research pattern — slinger handles this better
        reminder = (
            "helots MCP is connected. This Read uses an offset, which suggests section browsing — "
            "a research pattern that helot_slinger handles in one round-trip. "
            "Use helot_slinger with specific line range questions instead of paginating with Read."
        )
    else:
        # Large file read: if the intent is analysis/understanding rather than editing,
        # slinger summarizes locally — full file content never hits frontier context
        try:
            size = os.path.getsize(file_path) if file_path else 0
        except OSError:
            size = 0
        if size > 6000:  # ~100-150 lines
            reminder = (
                "helots MCP is connected. This file is large — if you're reading it to "
                "understand or analyse it (not to make an immediate targeted edit), use "
                "helot_slinger instead. Slinger summarizes locally; the full file content "
                "never hits the frontier context. Use Read directly only when you need "
                "the raw content in your own context."
            )

elif tool_name == 'WebFetch':
    url = tool_input.get('url', '')
    prompt = tool_input.get('prompt', '')
    # Large doc pages (GitHub, docs sites) return huge content that bloats context
    DOC_DOMAINS = ('github.com', 'docs.', '/docs/', 'readme', '.md', 'reference', 'api.')
    if any(d in url.lower() for d in DOC_DOMAINS):
        reminder = (
            "helots MCP is connected. This WebFetch targets a large doc/code page. "
            "Use helot_hoplite instead: ask it to fetch the URL and write a targeted summary "
            "to a temp .md file (e.g. /tmp/helots-doc-summary.md). "
            "Then Read only the summary — keeps the full page content off your context entirely. "
            "Note: helot_slinger cannot WebFetch; hoplite is the only helot with this capability."
        )

elif tool_name == 'Glob':
    pattern = tool_input.get('pattern', '')
    glob_path = tool_input.get('path', '')
    # Multi-level glob or searching from a directory root
    if '**' in pattern or not glob_path:
        reminder = (
            "helots MCP is connected. This is a broad Glob search — "
            "if you're exploring the codebase, use helot_slinger instead "
            "to preserve context window."
        )

if reminder:
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "additionalContext": f"[helots] {reminder}"
        }
    }
    print(json.dumps(output))

# Always increment frontier tool-call counter
import pathlib, json as _json
_counter_path = pathlib.Path.home() / '.claude' / 'helots-frontier-calls.json'
try:
    _data = _json.loads(_counter_path.read_text()) if _counter_path.exists() else {}
    _data['toolCalls'] = _data.get('toolCalls', 0) + 1
    _counter_path.write_text(_json.dumps(_data))
except Exception:
    pass

sys.exit(0)