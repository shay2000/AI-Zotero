# AI for Zotero tests

`*.js` files in this directory are intended for Zotero's chrome test runner.
They use mocked provider adapters and contain only synthetic fixture text—never
credentials or source text from a real library. The repository-local `scripts/run-tests.py` performs the
runtime-independent packaging and privacy checks; a Zotero 9 test profile can
load the JavaScript suites through the normal `test/tests` harness when the
plugin is installed.
