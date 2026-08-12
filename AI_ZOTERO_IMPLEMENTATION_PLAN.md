# AI for Zotero 9+ — Implementation Plan

## 1. Summary and deliverables

Build an installable Zotero 9+ plugin that adds:

- A reader-toolbar “AI Summary” action for open PDFs.
- An “Ask AI” control in Zotero’s text-selection popup, with streaming explanations and follow-up questions.
- An AI side-navigation section alongside Zotero’s existing notes and item functions.
- Collection-subtree cross-checking that identifies agreements, disagreements, recurring themes, unique contributions, and research gaps across PDFs.
- Direct support for Mistral, OpenRouter, and AgentRouter.
- Canonical summaries stored as ordinary Zotero notes so they sync, export, and remain readable if the plugin is removed.
- Original SVG icons that inherit Zotero theme colors and work in light, dark, high-contrast, compact, and scaled interfaces.

The first implementation commit must create this plan and `AGENTS.md` at the repository root, then add `ai-zotero-plugin/` containing the bootstrapped plugin source, tests, localization, icons, packaging scripts, and documentation.

The plugin will use Zotero’s supported reader event hooks and custom item-pane APIs rather than patching reader internals. Zotero officially recommends its item-pane registration API for plugins, and Zotero 9 is the current stable release line. [Zotero plugin APIs](https://www.zotero.org/support/dev/zotero_7_for_developers), [Zotero releases](https://www.zotero.org/downloads).

## 2. Architecture, interfaces, and persistence

### Plugin boundary

- Use a bootstrapped Zotero extension with stable ID `ai-zotero@shayprasad`.
- Expose one runtime namespace, `Zotero.AIZotero`, created during `startup()` and completely removed during `shutdown()`.
- Register and unregister reader `renderToolbar`, reader `renderTextSelectionPopup`, the custom item-pane AI section, the AI preferences pane, and the item/tab/collection observers needed to refresh visible state.
- Support plugin installation, enable, disable, and upgrade without restarting Zotero.
- Do not modify the uninitialized `reader`, `note-editor`, or `document-worker` submodules.
- Do not add tables or migrations to Zotero’s database.

### Internal service interfaces

Implement these stable internal contracts:

```js
ProviderAdapter {
  id;
  displayName;
  defaultBaseURL;
  listModels({ apiKey, baseURL, signal });
  testConnection({ apiKey, baseURL, model, signal });
  streamChat({
    apiKey,
    baseURL,
    model,
    messages,
    temperature,
    maxOutputTokens,
    signal,
    onDelta,
  });
}
```

```js
SourceDocument {
  attachmentID;
  libraryID;
  attachmentKey;
  parentItemID;
  title;
  collectionPaths;
  fingerprint;
  pages; // Ordered page/section records with stable local source IDs
  charCount;
  extractionWarnings;
}
```

```js
AIArtifactMetadata {
  schemaVersion;
  kind; // "summary", "crosscheck", or "saved-explanation"
  sourceKeys;
  sourceFingerprints;
  provider;
  model;
  promptVersion;
  createdAt;
  updatedAt;
  managedContentHash;
}
```

Core modules must remain separated into provider transport/SSE parsing, secure credential storage, PDF extraction/source normalization, token estimation/hierarchical chunking, prompt construction/structured-response validation, summary-note persistence, cross-check orchestration, reader/item-pane presentation, and preferences/localization.

UI code must never access API keys directly. It asks the provider service to execute an operation and receives status, deltas, structured results, or typed errors.

### Providers

Use a shared OpenAI-compatible chat-completions transport where wire-compatible, with provider-specific headers and response normalization.

- Mistral:
  - Base URL: `https://api.mistral.ai/v1`.
  - Chat: `/chat/completions`.
  - Models: `/models`.
  - Support streaming SSE and Mistral string or content-array responses. [Mistral API](https://docs.mistral.ai/api).
- OpenRouter:
  - Base URL: `https://openrouter.ai/api/v1`.
  - Chat: `/chat/completions`.
  - Models: `/models`.
  - Ignore SSE keep-alive comments and record the generation ID when returned.
  - Parse OpenRouter’s typed mid-stream errors rather than treating them as normal completion text. [OpenRouter chat API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion), [streaming](https://openrouter.ai/docs/api/reference/streaming).
- AgentRouter:
  - Default base URL: `https://co.agentrouter.org/v1`, matching its current OpenAI-compatible integration guide.
  - Make the base URL editable because the supplied `agentrouter.org/docs/index.html` documentation is JavaScript-rendered and older installations may use `https://agentrouter.org/v1`.
  - Attempt `/models`; if unavailable, retain a manually entered model ID.
  - Treat model availability as account-specific and never hard-code advertised model IDs. [AgentRouter integration guide](https://co.agentrouter.org/portal/guide).

Model catalogs are cached for 24 hours, with a manual refresh button. A removed or inaccessible model produces an actionable error and refresh prompt. The plugin must never silently switch providers or models because doing so changes cost and data handling.

Default generation parameters:

- Temperature: `0.2`.
- High-level summary output budget: `1,400` tokens.
- Highlight explanation output budget: `600` tokens.
- Cross-check synthesis output budget: `2,400` tokens.
- Unsupported optional parameters are omitted per model rather than sent blindly.
- The selected default provider/model may be overridden in every upload preview.

### Credentials and settings

- Store API keys through Firefox/Zotero’s asynchronous Login Manager APIs, with a separate realm for each provider.
- Never store keys in Zotero preferences, note content, logs, exception messages, XPI files, test snapshots, or model-cache records.
- Preferences contain only non-secret values: enabled state, default provider/model, AgentRouter base URL, summary detail level, cross-check concurrency/limits, and model-catalog cache metadata.
- Key fields are masked and offer Save, Replace, Remove, and Test Connection actions.
- “Test Connection” sends no Zotero content. If a provider requires a minimal completion instead of a model-list request, warn that the test may incur a negligible charge.
- Log request IDs, provider, model, timing, response status, and token usage only. Never log prompts, document text, selections, note bodies, or authorization headers.

### PDF extraction and chunking

- V1 supports PDF attachments only.
- Prefer Zotero’s structured PDF extraction capability when available so page boundaries and labels are retained.
- Add a capability adapter for Zotero 9 point releases: structured document extraction, existing indexed full-text cache, then PDF full-text worker fallback.
- Never upload the original PDF binary; only extracted text selected in the preview is sent.
- Normalize whitespace without merging pages, preserve headings where detectable, and assign immutable source IDs such as `S03-P014`.
- Compute a source fingerprint from the attachment hash plus extraction schema version.
- Recheck the fingerprint immediately before saving a result. If the PDF changed during generation, mark the output stale and require regeneration instead of overwriting the canonical note.
- Estimate tokens conservatively as `ceil(characters / 4)`, with an additional safety margin for CJK-heavy text.
- Reserve model context as 70% source/instructions, 15% expected output, and 15% protocol/estimation safety.
- Split on page, heading, paragraph, then sentence boundaries. Never split surrogate pairs or combining sequences.
- Use 10% overlap only when a semantic section spans chunks.
- Large PDFs use hierarchical map-reduce: per-chunk evidence extraction, section consolidation, whole-document synthesis, then citation validation.
- Source text is explicitly treated as untrusted quoted material. Prompts instruct the model to ignore commands or role instructions found inside documents.

### Structured results and safe rendering

The model must return validated JSON-like structures, not arbitrary HTML. Required summary fields are thesis/central question, key findings, methods/evidence, limitations/uncertainties, important terminology, implications/open questions, and evidence citations containing known source IDs.

Validation must reject unknown source IDs and malformed/out-of-range page references, retry once with a repair prompt when structure is invalid, and fall back to safe plain text without saving automatically if repair fails.

Escape all model text. Render notes from a fixed local HTML AST using only headings, paragraphs, lists, tables, emphasis, and Zotero navigation links. Never preserve model-supplied HTML, scripts, styles, images, event attributes, or unverified external links.

### Zotero note persistence

A summary is stored as a normal Zotero note:

- If the PDF belongs to a bibliographic parent, create the summary as a sibling child note under that parent and associate it specifically with the attachment.
- For a standalone PDF, create a standalone note in the same collections and associate it with the attachment.
- Title format: `AI Summary — <document title>`.
- Identify the canonical note using a synced `dc:relation` URN: `urn:ai-zotero:summary:<libraryID>:<attachmentKey>`.
- Store compact provenance as a second versioned URN relation and show readable provenance in a collapsed “Generation details” section.
- Use `Zotero.Relations.getByPredicateAndObject()` to locate the canonical artifact.
- If duplicates exist, select the newest valid related note, show a warning, and never delete or merge the others automatically.
- Each note contains managed generated sections, a stable `Personal notes` section that regeneration always preserves, provider/model, generation time, source fingerprint, and an AI accuracy warning.
- Store a hash of the last managed content. If a user edited the generated portion, regeneration must stop before save and show a diff/review choice; it must not silently destroy edits.
- Record the note version and `dateModified` before generation. If sync or another editor changes the note during the request, do not overwrite it.
- Commit a complete validated summary in one transaction. Cancellation or provider failure leaves the previous note untouched.
- Deleting an attachment does not automatically delete its summary note.

Cross-check reports are dated standalone notes added to the selected collection:

- Title: `AI Cross-check — <collection> — <date>`.
- Each new run creates a new report to avoid erasing comparisons made with different scopes.
- Explicitly refreshing an existing report updates only that report after the same edit/conflict checks.

## 3. User experience and workflows

### AI side-navigation section

Register an official custom item-pane section named “AI” with an original 20×20 SVG side-navigation icon.

For an open PDF, the AI section contains current summary state (Not generated, Generating, Current, Stale, Source missing, or Error), Generate/Regenerate Summary, Open Zotero note, Copy summary, Ask about this document, Cross-check collection, provider/model provenance, and extraction/privacy/citation warnings.

The summary is rendered read-only in the AI section; editing opens the underlying Zotero note so normal note behavior remains authoritative.

### Reader toolbar summary

Register a 24×24 document-and-spark SVG button through `renderToolbar`.

The button is visible only for eligible PDF readers, not previews or unsupported attachment types. Activation opens the AI pane and builds an upload preview showing provider/model, document title, page/character counts, estimated input size and likely requests, whether an existing summary will be updated, extraction warnings, and the statement that extracted text will be sent to the selected provider.

The user may change provider, model, and detail level. Confirm starts extraction/generation; Cancel sends nothing. Progress reports Extracting, Analysing chunks, Synthesising, Validating citations, and Saving note. A persistent Cancel control aborts all active network work.

Default “High-level” output is approximately 500–800 words. Optional Brief and Detailed settings may reduce or expand this without changing the persisted-note format.

### Highlighted-text explanations

Use `renderTextSelectionPopup` to append a compact quote-and-spark SVG button.

On activation, open an anchored, keyboard-accessible composer containing Explain simply, Explain in context, Define terms, Critique this claim, and Custom question.

Show the exact selected text and page label before confirmation. The upload preview identifies provider, model, selection length, and that only the selection plus limited surrounding context will be sent.

Stream the answer into the popover and permit follow-up questions within the in-memory session. Supply only selected text, page label, document title/bibliographic metadata, and bounded adjacent text for “in context”.

Do not persist conversations automatically. Provide Copy and Save to AI Summary. Save appends a validated “Saved explanations” entry to the canonical summary note including quote, question, answer, page link, and timestamp. Closing the reader or disabling the plugin aborts the request and removes the transient session.

The selection feature must work in reader tabs and separate reader windows and must not interfere with annotation creation, copying, or Zotero keyboard navigation.

### Collection-subtree cross-check

The AI section’s “Cross-check collection” action opens a scope dialog:

1. Default to the current collection when one is active; otherwise require collection selection.
2. Traverse all descendant collections.
3. Gather PDFs attached to regular items in the subtree and standalone PDFs directly in those collections.
4. Exclude trashed items, missing local files, unsupported attachments, and inaccessible linked files.
5. Deduplicate attachments by library ID and item key when an item appears in multiple subcollections.
6. Present a grouped file list with checkboxes, collection paths, page counts, extraction status, and existing-summary freshness.
7. Default limit: 25 included PDFs.
8. Hard limit: 100 PDFs. Runs above 25 require an additional cost/latency warning.
9. Show estimated requests and input size before confirmation.

Cross-check processing reuses a canonical summary dossier only when its source fingerprint and prompt schema are current. It generates ephemeral evidence dossiers for stale or unsummarised files without automatically creating individual summary notes, processes no more than two source documents concurrently, and runs synthesis serially after dossiers complete.

Reports contain executive synthesis, recurring-theme matrix, agreement areas, contradictions/tensions, methodological differences, unique contributions, gaps/unanswered questions, and source-coverage/extraction warnings. Every substantive comparison must cite at least one known source and page/section. A final verification pass removes unknown citations and labels weakly supported claims. Claims supported by only one document are labelled unique rather than shared.

V1 does not add embeddings or a permanent vector database; comparison is based on bounded evidence dossiers and a synthesis pass.

### Visual and accessibility requirements

Provide original SVGs for an AI document/spark icon, a quote-bubble/spark explanation icon, and overlapping comparison documents. All use `currentColor`, avoid raster assets and hard-coded backgrounds, have 16/20/24-pixel variants where required, remain legible at 100–200% scaling, include localized tooltips/accessibility names, show keyboard focus, support light/dark/black/high-contrast/RTL layouts, and avoid animation when reduced motion is enabled.

All user-visible text uses namespaced Fluent identifiers. Ship `en-US` initially while keeping every UI string localizable.

## 4. Reliability, security, and senior-level edge cases

### Network and provider behavior

- Use privileged `fetch`, `AbortController`, and an incremental SSE parser.
- Correctly handle frames split across arbitrary byte chunks, multiline `data:` fields, keep-alive comments, blank frames, and `[DONE]`.
- Default inactivity timeout: 120 seconds.
- Retry only idempotent pre-completion failures. Honor `Retry-After` for 429 and retry transient network/502/503/504 failures at most twice with exponential backoff and jitter.
- Never automatically retry after visible output has streamed unless the provider supplies a resumable protocol.
- Map authentication, insufficient-credit, model-not-found, context-length, moderation, rate-limit, timeout, offline, TLS, and malformed-response failures to distinct messages.
- Do not save partial summaries. Preserve partial explanation text for copying after a mid-stream failure, but label it incomplete.
- Do not silently fall back to another provider.

### Privacy and prompt safety

- No background summarisation, indexing, prefetching, or uploads.
- Every document, selection, and cross-check operation requires its own explicit preview and confirmation.
- The preview lists every file that will contribute text.
- Never send unrelated notes, attachments, annotations, tags, collections, or full-library metadata.
- Treat PDFs as potential prompt-injection sources.
- State clearly that provider retention/training policies are controlled by the selected external provider.
- Provide no telemetry.
- Redact secrets and source content from logs and crash-visible errors.

### Zotero-specific failure cases

Handle scanned/image-only PDFs, password-protected PDFs, missing/moved/offline linked files, malformed PDFs, extreme page counts, extraction-worker crashes, standalone attachments, multiple PDFs on one bibliographic item, duplicate collection membership, read-only group libraries, moved attachments, source/note changes during requests, sync conflicts, reader/tab/plugin shutdown, duplicate concurrent summary requests, title collisions, malicious model output, oversized output, invalid Unicode, bidi controls, untrusted URLs, unavailable model catalogs, offline mode, captive portals, and rapid Zotero release changes.

Read-only libraries may generate and copy results but must disable note persistence with an explanation. Attachment deletion must not silently delete summaries. Capability detection must fail cleanly when an internal extraction method changes.

## 5. Implementation sequence and test plan

### Phase 1 — Documentation and plugin scaffold

- Write the root plan and `AGENTS.md`.
- Scaffold the bootstrapped Zotero 9+ plugin, manifest, preferences, Fluent localization, build scripts, and XPI packaging.
- Add lifecycle cleanup and namespace tests before feature registration.
- Produce `dist/ai-zotero.xpi`; do not commit built XPI files.
- Use AGPL-3.0-or-later to remain compatible with the surrounding Zotero codebase.

### Phase 2 — Provider and credential foundation

Implement Login Manager storage, common fetch/SSE transport, typed errors, all three provider adapters, model discovery/caching/manual fallback, Test Connection, and a local mock HTTP/SSE server. Automated tests must never call real providers.

### Phase 3 — Extraction and summary pipeline

Implement Zotero 9 extraction capability detection, page normalization, fingerprints, token estimation, chunk planning, map-reduce summarisation, response validation, citation checks, safe note rendering, canonical note lookup/creation/transactional update, personal-note preservation, edit detection, sync-conflict prevention, AI preferences, and the upload preview.

### Phase 4 — Reader and AI-section integration

Register toolbar, selection popup, and AI side section. Implement streaming progress, cancellation, summary display, follow-up explanation sessions, Save to AI Summary, SVG icons, and accessibility behavior. Verify tabbed and standalone readers.

### Phase 5 — Collection cross-checker

Implement recursive collection traversal, attachment gathering, deduplication, exclusions, preview estimates, evidence-dossier reuse, bounded concurrency, synthesis, validation, and report-note creation. Add source navigation links, cancellation, and partial-failure reporting.

### Automated tests

Provider tests cover endpoints, headers, body normalization, fragmented SSE, keep-alive comments, `[DONE]`, Unicode boundaries, usage records, mid-stream errors, authentication, credits, rate limits, retries, timeouts, cancellation, malformed JSON, model removal, and AgentRouter model-list fallback.

Extraction/reasoning tests cover short, long, empty, CJK, RTL, scanned, encrypted, and malformed PDFs; stable page/source IDs; safe chunk budgets; prompt-injection handling; citation rejection; source-change invalidation; cross-check deduplication; and shared-versus-unique theme classification.

Persistence tests cover first-run creation, canonical regeneration, personal-note preservation, manual-edit detection, concurrent modification, standalone PDFs, read-only libraries, duplicate relations, cancellation, failure atomicity, and unchanged prior notes.

UI/lifecycle tests cover exactly-once toolbar/selection injection, valid AI-section contexts, disable/uninstall cleanup, keyboard focus, accessibility, RTL, reduced motion, themes, scaling, accurate upload previews, and confirmation-before-network behavior.

Manual acceptance must cover the latest Zotero 9 on macOS, Windows, and Linux; personal and group libraries; stored and linked PDFs; reader tabs/windows; light/dark/black/high-contrast themes; install/upgrade/disable/uninstall; offline/provider outages; and sync during generation.

Release acceptance requires a clean XPI build, passing tests, no credentials/document text in artifacts, no upload without confirmation, no unverified citation presented as valid, no overwritten user/sync edits, one smoke test with a user-supplied key for each provider, and complete cleanup without restarting Zotero.

## 6. Assumptions and defaults

- Packaging is an installable plugin, not a permanent Zotero fork.
- Initial compatibility target is Zotero 9 and later; Zotero 7–8 compatibility is out of scope.
- V1 processes PDFs only.
- Users supply and pay for their own provider credentials.
- There is no plugin-operated proxy, cloud database, telemetry service, embeddings index, or account system.
- Summaries are ordinary Zotero notes; no private plugin database is introduced.
- Summary regeneration updates one canonical artifact while protecting personal and concurrent edits.
- Cross-checking operates on a chosen collection and all descendant collections, with per-file exclusions.
- Every upload is explicitly previewed and confirmed.
- AgentRouter’s endpoint remains configurable because its public documentation and gateway addresses have changed.
- OCR, local/offline models, PDF binary upload, automatic background summarisation, web search, and arbitrary custom OpenAI-compatible providers are deferred beyond V1.
