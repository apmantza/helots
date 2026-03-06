#!/usr/bin/env python3
"""
helots-format.py — PostToolUse hook: auto-format files written/edited by Claude.

Fires after Edit, Write, NotebookEdit.
Auto-detects the formatter configured in the current project — no hardcoding.

Detection order:
  TypeScript/JavaScript:
    1. biome.json or "biome" in package.json devDependencies → biome format --write
    2. .prettierrc* or "prettier" in package.json devDependencies → prettier --write
    3. Global biome → biome format --write
    4. Global prettier → prettier --write

  Python:
    1. ruff.toml or [tool.ruff] in pyproject.toml → ruff format
    2. [tool.black] in pyproject.toml → black
    3. Global ruff → ruff format
    4. Global black → black

  Other file types: skip silently

Skips silently if:
  - No formatter detected
  - File type not supported
  - Formatter exits non-zero (don't block Claude on format failures)
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from helots_common import is_enabled

TS_JS_EXTS = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'}
PYTHON_EXTS = {'.py'}


# ── Formatter detection ───────────────────────────────────────────────────────

def find_package_json(start: pathlib.Path) -> pathlib.Path | None:
    """Walk up from start to find package.json."""
    for parent in [start, *start.parents]:
        candidate = parent / 'package.json'
        if candidate.exists():
            return candidate
    return None


def has_dep(pkg_json: pathlib.Path, name: str) -> bool:
    try:
        data = json.loads(pkg_json.read_text(encoding='utf-8'))
        for key in ('dependencies', 'devDependencies', 'peerDependencies'):
            if name in data.get(key, {}):
                return True
    except Exception:
        pass
    return False


def find_biome(project_root: pathlib.Path) -> list[str] | None:
    """Return biome command if configured or globally available."""
    biome_json = project_root / 'biome.json'
    pkg_json = find_package_json(project_root)
    local_bin = project_root / 'node_modules' / '.bin' / 'biome'

    project_has_biome = biome_json.exists() or (pkg_json and has_dep(pkg_json, '@biomejs/biome'))

    if project_has_biome and local_bin.exists():
        return [str(local_bin), 'format', '--write']
    if project_has_biome and shutil.which('biome'):
        return ['biome', 'format', '--write']
    # Global fallback even without project config
    if shutil.which('biome'):
        return ['biome', 'format', '--write']
    return None


def find_prettier(project_root: pathlib.Path) -> list[str] | None:
    """Return prettier command if configured or globally available."""
    PRETTIER_CONFIGS = [
        '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs',
        '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.toml', 'prettier.config.js',
    ]
    pkg_json = find_package_json(project_root)
    local_bin = project_root / 'node_modules' / '.bin' / 'prettier'

    has_config = any((project_root / c).exists() for c in PRETTIER_CONFIGS)
    has_pkg_dep = pkg_json and has_dep(pkg_json, 'prettier')
    project_has_prettier = has_config or has_pkg_dep

    if project_has_prettier and local_bin.exists():
        return [str(local_bin), '--write']
    if project_has_prettier and shutil.which('prettier'):
        return ['prettier', '--write']
    if shutil.which('prettier'):
        return ['prettier', '--write']
    return None


def find_ruff(project_root: pathlib.Path) -> list[str] | None:
    ruff_toml = project_root / 'ruff.toml'
    pyproject = project_root / 'pyproject.toml'
    has_config = ruff_toml.exists()
    if not has_config and pyproject.exists():
        try:
            has_config = '[tool.ruff]' in pyproject.read_text(encoding='utf-8')
        except Exception:
            pass
    if has_config and shutil.which('ruff'):
        return ['ruff', 'format']
    if shutil.which('ruff'):
        return ['ruff', 'format']
    return None


def find_black(project_root: pathlib.Path) -> list[str] | None:
    pyproject = project_root / 'pyproject.toml'
    has_config = False
    if pyproject.exists():
        try:
            has_config = '[tool.black]' in pyproject.read_text(encoding='utf-8')
        except Exception:
            pass
    if has_config and shutil.which('black'):
        return ['black']
    return None


def detect_formatter(file_path: pathlib.Path, cwd: pathlib.Path) -> list[str] | None:
    ext = file_path.suffix.lower()
    project_root = file_path.parent  # start from file's directory

    if ext in TS_JS_EXTS:
        return find_biome(cwd) or find_prettier(cwd)

    if ext in PYTHON_EXTS:
        return find_ruff(cwd) or find_black(cwd)

    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_input = data.get('tool_input', {})
    file_path = tool_input.get('file_path') or tool_input.get('notebook_path', '')
    cwd = data.get('cwd', '')

    if not file_path or not cwd:
        sys.exit(0)

    if not is_enabled('helots-format', cwd):
        sys.exit(0)

    p = pathlib.Path(file_path)
    if not p.is_absolute():
        p = pathlib.Path(cwd) / p

    if not p.exists():
        sys.exit(0)

    cwd_path = pathlib.Path(cwd)
    formatter = detect_formatter(p, cwd_path)
    if not formatter:
        sys.exit(0)

    # Run formatter — never block Claude on failure
    subprocess.run(
        formatter + [str(p)],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    sys.exit(0)


if __name__ == '__main__':
    main()
