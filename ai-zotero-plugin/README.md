# AI for Zotero

AI for Zotero is a bootstrapped Zotero 9+ plugin for explicitly confirmed PDF
summaries, selected-text explanations, and collection-subtree cross-checks.
It sends extracted text only after a preview identifies the provider, model,
files, approximate size, and warnings. API keys are stored in the platform
Login Manager and are never written to Zotero preferences, notes, logs, or the
XPI.

## Build

From this directory:

```sh
python3 scripts/build.py
```

The generated `dist/ai-zotero.xpi` is intentionally ignored by source control.
The build is dependency-free and creates a deterministic ZIP/XPI from the
plugin source. `python3 scripts/run-tests.py` builds and inspects the XPI and
checks the privacy invariants. `python3 scripts/run-tests.py --audit` runs the
source-only checks.

## Install for development

Build the XPI and install it through Zotero's Add-ons Manager. The extension
uses the stable ID `ai-zotero@shayprasad`, registers only supported Zotero
plugin APIs, and cleans up listeners, observers, panes, and active requests on
disable, upgrade, uninstall, and application shutdown.

## Provider configuration

Mistral, OpenRouter, and AgentRouter use their OpenAI-compatible chat
completion APIs. AgentRouter's base URL is editable because installations may
use either the `co.agentrouter.org` or legacy `agentrouter.org` gateway. Model
catalogs are cached for 24 hours and can be manually refreshed. A provider or
model is never changed implicitly.

## Source and note safety

PDFs are normalized into page-labelled source records with stable IDs and a
fingerprint. Prompts mark PDF text as untrusted quoted material. Structured
responses are validated against known source IDs before rendering through a
fixed safe HTML renderer. Canonical summaries and cross-check reports are
ordinary Zotero notes with synced relation URNs, readable provenance, and a
preserved Personal notes section. User edits and concurrent sync changes stop
regeneration rather than being overwritten.

This is an initial implementation scaffold. Manual acceptance still needs to
be run against the latest Zotero 9 release on macOS, Windows, and Linux with
user-supplied provider keys, including read-only groups, linked files, reader
windows, provider outages, and sync during generation.
