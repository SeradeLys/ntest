#!/usr/bin/env python3
"""Rebuild data/menus/manifest.json from the menu files in data/menus/.

Drop Nutrislice-format menu files (one hall + one date each, e.g. west--2026-10-24.json)
into data/menus/, then run:  python3 tools/build-menu-manifest.py

Each file must contain {"hall": "west"|"east", "date": "YYYY-MM-DD", "items": [...]}.
Files that don't match are reported and left out of the manifest.
"""
import json, re, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent / "data" / "menus"
halls = {"west", "east"}
files, bad = [], []
for p in sorted(root.glob("*.json")):
    if p.name == "manifest.json":
        continue
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        ok = d.get("hall") in halls and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(d.get("date", ""))) and isinstance(d.get("items"), list)
    except Exception as e:
        ok = False
    (files if ok else bad).append(p.name)

(root / "manifest.json").write_text(json.dumps({"files": files}, indent=2) + "\n", encoding="utf-8")
print(f"manifest.json: {len(files)} menu file(s)")
for f in files: print("  +", f)
for f in bad: print("  ! skipped (not a valid menu file):", f, file=sys.stderr)
sys.exit(1 if bad else 0)
