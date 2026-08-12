# AI-Zotero Agent Instructions

## Mission

This repository is planning an installable Zotero 9+ plugin that provides PDF
summaries, highlighted-text explanations, and collection-subtree AI
cross-checks. The authoritative product and implementation specification is
`AI_ZOTERO_IMPLEMENTATION_PLAN.md` at the repository root.

## Scope and boundaries

- Work inside `ai-zotero-plugin/` for the planned plugin implementation.
- Do not modify Zotero core, the `reader/`, `note-editor/`, or
  `document-worker/` submodules unless the plan is explicitly revised first.
- Do not add Zotero database tables or migrations for plugin state.
- Target Zotero 9 and later. Use supported reader event hooks,
  `Zotero.ItemPaneManager`, `Zotero.PreferencePanes`, notifier APIs, and
  asynchronous Login Manager APIs instead of monkey-patching UI internals.
- Keep generated XPI/build output out of source control unless explicitly
  requested.

## Privacy and security rules

- API keys belong in the platform Login Manager only. Never put secrets in
  preferences, notes, source files, fixtures, logs, exceptions, screenshots,
  or test snapshots.
- Never upload document text, selections, or metadata in the background.
  Every operation needs an explicit preview and confirmation showing provider,
  model, files, approximate size, and warnings.
- Never log prompts, source text, note bodies, authorization headers, or raw
  provider responses. Redact errors and record only safe diagnostics.
- Do not silently change provider/model or fall back to another provider.
- Treat PDF contents and model output as untrusted. Validate source IDs and
  citations, escape generated HTML, and render through a fixed safe AST.
- Preserve user-edited notes and never overwrite a note changed during an
  in-flight request or sync operation.

## Engineering conventions

- Read the implementation plan before changing code and update it when a
  product or interface decision changes.
- Keep provider transport, extraction, chunking, persistence, orchestration,
  and UI layers separate and testable.
- Localize all user-visible strings with namespaced Fluent identifiers.
- Use accessible, theme-aware SVG icons with `currentColor`; support keyboard
  focus, RTL, reduced motion, high contrast, and zoomed layouts.
- Prefer small, reviewable patches. Preserve existing user changes and inspect
  `git status` before and after edits.
- Use tabs and the repository's existing Zotero JavaScript conventions.
- Add tests for provider parsing, cancellation, retries, extraction edge cases,
  note upsert/conflicts, collection deduplication, privacy previews, and
  plugin shutdown cleanup. Automated tests must use mocked providers.

## Required verification before handoff

- Confirm the plugin builds into an XPI without modifying Zotero core.
- Run lint and all plugin unit/integration tests.
- Check that no credentials or document text appear in generated logs or test
  artifacts.
- Exercise installation, disable/re-enable, upgrade, and uninstall cleanup.
- Manually smoke-test the latest Zotero 9 on macOS, Windows, and Linux when
  UI work is complete.
