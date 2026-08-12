#!/usr/bin/env python3
"""Run source-level checks that are safe outside a Zotero runtime.

The JavaScript suites in tests/ are loaded by Zotero's chrome test runner. This
script validates packaging, localization, SVG safety, and privacy invariants so
CI can still catch accidental regressions without provider credentials or a
running Zotero instance.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def assert_true(condition, message):
	if not condition:
		raise AssertionError(message)


def audit_source():
	manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
	assert_true(manifest["applications"]["zotero"]["id"] == "ai-zotero@shayprasad", "stable ID changed")
	assert_true((ROOT / "bootstrap.js").is_file(), "bootstrap.js missing")
	ftl = (ROOT / "locale/en-US/ai-zotero.ftl").read_text(encoding="utf-8")
	assert_true("ai-zotero-" in ftl, "localization namespace missing")
	all_source = "\n".join(
		path.read_text(encoding="utf-8")
		for path in ROOT.rglob("*")
		if path.is_file() and path.suffix in {".js", ".xhtml", ".css", ".ftl", ".json"}
		and "dist" not in path.parts
		and "tests" not in path.parts
		and "scripts" not in path.parts
	)
	for pattern in (r"sk-[A-Za-z0-9]{20,}", r"AIza[0-9A-Za-z_-]{20,}"):
		assert_true(not re.search(pattern, all_source), f"credential-like material matched {pattern}")
	for path in (ROOT / "icons").glob("*.svg"):
		text = path.read_text(encoding="utf-8")
		assert_true("currentColor" in text, f"{path.name} does not inherit theme color")
		assert_true("<script" not in text.lower(), f"script found in {path.name}")
		assert_true("data:" not in text.lower(), f"embedded raster data found in {path.name}")


def build_and_inspect():
	build_script = ROOT / "scripts/build.py"
	subprocess.run([sys.executable, str(build_script)], check=True, cwd=ROOT)
	xpi = ROOT / "dist/ai-zotero.xpi"
	with zipfile.ZipFile(xpi) as archive:
		names = set(archive.namelist())
		assert_true("tests" not in " ".join(names), "test sources leaked into XPI")
		assert_true("bootstrap.js" in names, "bootstrap.js missing from XPI")
		assert_true("manifest.json" in names, "manifest missing from XPI")
		for name in names:
			data = archive.read(name)
			assert_true(not re.search(rb"Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}", data), f"authorization header in {name}")
			assert_true(not re.search(rb"\bsk-[A-Za-z0-9]{20,}", data), f"provider secret prefix in {name}")


def main(argv=None):
	parser = argparse.ArgumentParser()
	parser.add_argument("--audit", action="store_true", help="skip the XPI build")
	args = parser.parse_args(argv)
	try:
		audit_source()
		if not args.audit:
			build_and_inspect()
	except (AssertionError, OSError, subprocess.CalledProcessError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
		print(f"plugin checks failed: {exc}", file=sys.stderr)
		return 1
	print("plugin source and privacy checks passed")
	return 0


if __name__ == "__main__":
	sys.exit(main())
