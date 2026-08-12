#!/usr/bin/env python3
"""Build a deterministic XPI without requiring Node or a network connection."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "dist" / "ai-zotero.xpi"
REQUIRED_FILES = (
	"manifest.json",
	"bootstrap.js",
	"defaults/preferences/ai-zotero.js",
	"locale/en-US/ai-zotero.ftl",
	"icons/ai-summary-16.svg",
	"icons/ai-summary-20.svg",
	"icons/ai-summary-24.svg",
	"icons/ai-explain-16.svg",
	"icons/ai-explain-20.svg",
	"icons/ai-explain-24.svg",
	"icons/ai-compare-16.svg",
	"icons/ai-compare-20.svg",
	"icons/ai-compare-24.svg",
)


def iter_source_files():
	for path in sorted(ROOT.rglob("*")):
		if not path.is_file():
			continue
		relative = path.relative_to(ROOT)
		if relative.parts[0] in {"dist", "scripts", "tests"}:
			continue
		if relative.name in {"package.json", ".gitignore", "README.md"}:
			continue
		if relative.suffix in {".xpi", ".log", ".pyc"}:
			continue
		yield relative


def validate_source():
	manifest_path = ROOT / "manifest.json"
	manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
	application = manifest.get("applications", {}).get("zotero", {})
	if application.get("id") != "ai-zotero@shayprasad":
		raise ValueError("manifest has an unexpected stable plugin ID")
	if not str(application.get("strict_min_version", "")).startswith("9"):
		raise ValueError("manifest must target Zotero 9+")
	missing = [relative for relative in REQUIRED_FILES if not (ROOT / relative).is_file()]
	if missing:
		raise ValueError("missing required plugin files: " + ", ".join(missing))
	for relative in iter_source_files():
		data = (ROOT / relative).read_bytes()
		if re.search(rb"Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}", data):
			raise ValueError(f"possible credential material in source file: {relative}")
		if re.search(rb"\bsk-[A-Za-z0-9]{20,}", data) or b"api_key" in data.lower():
			raise ValueError(f"possible credential material in source file: {relative}")


def build(output: Path):
	validate_source()
	output.parent.mkdir(parents=True, exist_ok=True)
	if output.exists():
		output.unlink()
	with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
		for relative in iter_source_files():
			info = zipfile.ZipInfo(str(relative).replace(os.sep, "/"))
			info.date_time = (2020, 1, 1, 0, 0, 0)
			info.compress_type = zipfile.ZIP_DEFLATED
			info.external_attr = 0o644 << 16
			archive.writestr(info, (ROOT / relative).read_bytes())
	return output


def main(argv=None):
	parser = argparse.ArgumentParser()
	parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
	args = parser.parse_args(argv)
	try:
		path = build(args.output.resolve())
	except (OSError, ValueError, json.JSONDecodeError) as exc:
		print(f"build failed: {exc}", file=sys.stderr)
		return 1
	print(f"built {path} ({path.stat().st_size} bytes)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
