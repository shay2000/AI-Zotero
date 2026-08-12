/*
	Network orchestration for AI for Zotero.

	The service owns preview tokens and confirmation. This module receives only
	confirmed operations, extracts local PDF text, calls one selected provider,
	validates the structured response, and then asks the note module to perform
	the guarded persistence step.
*/

(function (global) {
	"use strict";

	const modules = global.__AIZoteroModules || (global.__AIZoteroModules = {});
	const DEFAULTS = {
		provider: "mistral",
		detail: "high-level",
		baseURLs: {
			mistral: "https://api.mistral.ai/v1",
			openrouter: "https://openrouter.ai/api/v1",
			agentrouter: "https://co.agentrouter.org/v1",
		},
	};

	function text(value) {
		return value === null || value === undefined ? "" : String(value);
	}

	function checkAbort(signal) {
		if (!signal?.aborted) return;
		let error = new Error("Operation cancelled");
		error.name = "AbortError";
		error.code = "CANCELED";
		throw error;
	}

	function itemFor(context) {
		if (context?.item) return Promise.resolve(context.item);
		let zotero = global.Zotero || {};
		if (context?.attachmentID && zotero.Items?.getAsync) {
			return zotero.Items.getAsync(context.attachmentID);
		}
		if (context?.attachmentID && zotero.Items?.get) {
			return Promise.resolve(zotero.Items.get(context.attachmentID));
		}
		return Promise.resolve(null);
	}

	function providerOptions(preview, options = {}) {
		let provider = text(preview?.provider || DEFAULTS.provider).toLowerCase();
		let definition = modules.providers?.providerDefinitions?.[provider];
		return {
			provider,
			baseURL: text(preview?.baseURL || definition?.defaultBaseURL || DEFAULTS.baseURLs[provider]),
			model: text(preview?.model || options.model),
			temperature: 0.2,
			signal: options.signal,
			maxOutputTokens: options.maxOutputTokens,
			includeUsage: true,
		};
	}

	function ensureModel(preview, options = {}) {
		let model = text(preview?.model || options.model).trim();
		if (!model) {
			let error = new Error("A model must be selected before confirmation");
			error.code = "model-not-found";
			throw error;
		}
		return model;
	}

	function sourceIDs(source) {
		return (source?.pages || []).map(page => page.sourceId || page.id).filter(Boolean);
	}

	function safeValidation(value) {
		if (!value || typeof value !== "object") return null;
		return {
			ok: value.ok !== false,
			repaired: Boolean(value.repaired),
			errors: Array.isArray(value.errors)
				? value.errors.map(error => ({
					code: text(error?.code).slice(0, 100),
					path: text(error?.path).slice(0, 200),
				})).slice(0, 100)
				: [],
		};
	}

	function safePersistence(value) {
		if (!value || typeof value !== "object") return { saved: false };
		return {
			saved: value.saved === true,
			created: value.created === true,
			noteID: Number.isInteger(value.note?.id) ? value.note.id : (Number.isInteger(value.noteID) ? value.noteID : null),
			relationURN: text(value.relationURN).slice(0, 500),
			provenanceURN: text(value.provenanceURN).slice(0, 500),
			reason: text(value.reason).slice(0, 120),
			stale: Boolean(value.stale),
			cancelled: Boolean(value.cancelled),
			canCopy: Boolean(value.canCopy),
			warnings: Array.isArray(value.warnings) ? value.warnings.map(text).slice(0, 20) : [],
		};
	}

	function pageForSelection(selection) {
		let page = Number.isInteger(selection?.pageIndex) ? selection.pageIndex + 1 : 1;
		return {
			sourceId: `S01-P${String(Math.max(1, page)).padStart(3, "0")}`,
			id: `S01-P${String(Math.max(1, page)).padStart(3, "0")}`,
			pageNumber: Math.max(1, page),
			label: text(selection?.pageLabel || page),
			text: text(selection?.selectedText || selection?.text),
		};
	}

	async function attachmentHash(attachment) {
		try {
			if (typeof attachment?.getAttachmentHash === "function") {
				return text(await attachment.getAttachmentHash());
			}
			return text(await attachment?.attachmentHash);
		}
		catch (e) {
			return "";
		}
	}

	async function currentFingerprint(attachment, source) {
		let hash = await attachmentHash(attachment);
		if (modules.extraction?.computeFingerprint) {
			return modules.extraction.computeFingerprint({
				attachmentHash: hash,
				pages: source?.pages,
			});
		}
		return source?.fingerprint || "";
	}

	function extractOptions(options) {
		return {
			signal: options.signal,
			onProgress: options.onProgress,
			zotero: global.Zotero,
		};
	}

	async function extract(attachment, options = {}) {
		if (!modules.extraction?.extractDocument) {
			let error = new Error("PDF extraction module is unavailable");
			error.code = "module-unavailable";
			throw error;
		}
		return modules.extraction.extractDocument(attachment, extractOptions(options));
	}

	function noteLookup(attachment) {
		if (!modules.notes?.findCanonicalNote) return Promise.resolve({ note: null, notes: [] });
		return modules.notes.findCanonicalNote(attachment, { zotero: global.Zotero });
	}

	function estimate(source, plan) {
		let tokens = plan?.totalTokenEstimate || modules.chunking?.estimateTokens?.(
			(source?.pages || []).map(page => page.text || "").join("\n")
		) || Math.ceil((source?.charCount || 0) / 4);
		let chunks = plan?.leafChunks?.length || 1;
		return {
			pageCount: source?.pageCount || source?.pages?.length || 0,
			charCount: source?.charCount || 0,
			estimatedInputTokens: Math.ceil(tokens),
			estimatedRequests: chunks + 1,
		};
	}

	async function prepareSummary({ context, item }) {
		let attachment = item || await itemFor(context);
		if (!attachment?.isPDFAttachment?.() && attachment?.attachmentContentType !== "application/pdf") {
			return { title: context?.title || "PDF", warnings: ["unsupported-attachment-type"] };
		}
		let source = await extract(attachment, {});
		let plan = modules.chunking?.planHierarchicalChunks?.(source) || null;
		let lookup = await noteLookup(attachment);
		let values = estimate(source, plan);
		let warnings = (source.extractionWarnings || []).map(warning => warning.code || warning);
		if (lookup.duplicate) warnings.push("duplicate-canonical-relations");
		if (source.charCount === 0) warnings.push("no-extracted-text");
		return {
			title: source.title || context?.title || "PDF",
			pageCount: values.pageCount,
			charCount: values.charCount,
			estimatedInputTokens: values.estimatedInputTokens,
			estimatedRequests: values.estimatedRequests,
			existingSummaryUpdate: Boolean(lookup.note),
			warnings,
		};
	}

	async function prepareExplanation({ context, item }) {
		let selection = context?.selectionText || "";
		return {
			title: context?.title || item?.getField?.("title") || "PDF",
			pageLabel: context?.pageLabel || "",
			selectionLength: selection.length,
			charCount: selection.length + (context?.surroundingText || "").length,
			estimatedInputTokens: Math.ceil((selection.length + (context?.surroundingText || "").length) / 4),
			estimatedRequests: 1,
			warnings: context?.surroundingText ? [] : ["bounded-context-unavailable"],
		};
	}

	async function prepareCrossCheck({ context }) {
		let collectionID = context?.collectionID;
		if (!collectionID) return { warnings: ["collection-selection-required"], files: [] };
		let scope = await modules.crosscheck.planCollectionScope(collectionID, {
			zotero: global.Zotero,
			limit: 25,
			hardLimit: 100,
		});
		let files = (scope.selected || []).map(candidate => ({
			title: candidate.title,
			pageCount: candidate.pageCount || 0,
			charCount: candidate.charCount || 0,
			collectionPath: candidate.collectionPaths?.[0] || [],
			status: "ready",
			freshness: candidate.existingSummaryFreshness || "unknown",
		}));
		let estimateValue = modules.crosscheck.estimateScope(scope);
		return {
			files,
			pageCount: estimateValue.pages,
			charCount: estimateValue.characters,
			estimatedInputTokens: estimateValue.estimatedInputTokens,
			estimatedRequests: estimateValue.estimatedRequests,
			warnings: (scope.warnings || []).map(warning => warning.code || warning).concat(
				scope.requiresCostWarning ? ["cost-latency-warning"] : []
			),
			collectionName: context?.collectionName || "selected collection",
		};
	}

	async function streamJSON(prompt, preview, options = {}) {
		let provider = providerOptions(preview, options);
		provider.model = ensureModel(preview, options);
		let parts = [];
		let result = await modules.providers.streamChat({
			...provider,
			messages: prompt.messages,
			maxOutputTokens: options.maxOutputTokens,
			onDelta: (delta, metadata) => {
				parts.push(delta);
				if (typeof options.onDelta === "function") options.onDelta(delta, metadata);
			},
		});
		return { text: result?.text || parts.join(""), metadata: result };
	}

	async function collectChunkEvidence(source, plan, preview, options = {}) {
		let chunks = Array.isArray(plan?.leafChunks) ? plan.leafChunks : [];
		if (chunks.length <= 1) return [];
		let results = new Array(chunks.length);
		let nextIndex = 0;
		let worker = async () => {
			while (true) {
				checkAbort(options.signal);
				let index = nextIndex++;
				if (index >= chunks.length) return;
				let chunk = chunks[index];
				try {
					let prompt = modules.prompts.buildChunkEvidencePrompt({
						source,
						chunk,
						outputBudget: 600,
					});
					let streamed = await streamJSON(prompt, preview, {
						signal: options.signal,
						// Intermediate evidence is intentionally not streamed to the UI;
						// only the final validated synthesis is user-facing.
						onDelta: null,
						maxOutputTokens: 600,
					});
					let parsed = modules.validation.parseStructuredResponse(streamed.text);
					let evidence = Array.isArray(parsed.value?.evidence) ? parsed.value.evidence : [];
					let valid = [];
					for (let entry of evidence.slice(0, 100)) {
						if (!entry || typeof entry.claim !== "string" || !entry.claim.trim()) continue;
						let citations = modules.validation.validateCitations(entry.citations, [source], {
							knownSourceIds: sourceIDs(source),
						});
						if (!citations.errors.length) {
							valid.push({ claim: entry.claim, citations: citations.values });
						}
					}
					results[index] = {
						chunkId: chunk.chunkId || chunk.id,
						sourceIds: chunk.sourceIds || [],
						pageNumbers: chunk.pageNumbers || [],
						evidence: valid,
					};
				}
				catch (error) {
					if (error?.name === "AbortError" || error?.code === "CANCELED") throw error;
					results[index] = {
						chunkId: chunk.chunkId || chunk.id,
						sourceIds: chunk.sourceIds || [],
						pageNumbers: chunk.pageNumbers || [],
						evidence: [],
					};
				}
			}
		};
		await Promise.all([worker(), worker()]);
		return results.filter(Boolean);
	}

	async function repairCandidate(candidate, prompt, preview, options) {
		let result = await streamJSON(prompt, preview, {
			...options,
			onDelta: null,
			maxOutputTokens: options.maxOutputTokens || 1400,
		});
		return result.text;
	}

	async function runSummary({ context, preview, signal, onProgress, onDelta }) {
		let attachment = await itemFor(context);
		if (!attachment) throw Object.assign(new Error("PDF attachment not found"), { code: "file-missing" });
		onProgress?.({ stage: "extracting", percent: 8 });
		let source = await extract(attachment, { signal, onProgress });
		if (!source.charCount) throw Object.assign(new Error("No selectable PDF text was found"), { code: "unsupported" });
		onProgress?.({ stage: "analysing-chunks", percent: 28 });
		let plan = modules.chunking.planHierarchicalChunks(source);
		let synthesisChunks = plan.leafChunks;
		if (plan.leafChunks.length > 1) {
			onProgress?.({ stage: "analysing-chunks", percent: 42 });
			let chunkEvidence = await collectChunkEvidence(source, plan, preview, { signal });
			// The synthesis pass receives only bounded, validated evidence rather
			// than the full PDF text, while retaining exact source/page citations.
			synthesisChunks = chunkEvidence.map(value => ({
				chunkId: value.chunkId,
				id: value.chunkId,
				sourceIds: value.sourceIds,
				pageNumbers: value.pageNumbers,
				text: JSON.stringify({ evidence: value.evidence }),
			}));
		}
		let prompt = modules.prompts.buildSummaryPrompt({
			source,
			chunks: synthesisChunks,
			detail: preview.detailLevel || DEFAULTS.detail,
			outputBudget: 1400,
		});
		let streamed = await streamJSON(prompt, preview, { signal, onDelta, maxOutputTokens: 1400 });
		onProgress?.({ stage: "synthesising", percent: 72 });
		let knownSourceIds = sourceIDs(source);
		let validation = await modules.validation.validateWithRepair(streamed.text, {
			kind: "summary",
			sources: [source],
			knownSourceIds,
			repair: async ({ prompt: repairPrompt }) => repairCandidate(streamed.text, repairPrompt, preview, { signal }),
		});
		if (!validation.ok) {
			return {
				ok: false,
				manualReviewRequired: true,
				plainText: modules.validation.safePlainText(streamed.text, { kind: "summary" }),
				validation: safeValidation(validation),
			};
		}
		onProgress?.({ stage: "validating-citations", percent: 88 });
		let lookup = await noteLookup(attachment);
		let snapshot = lookup.note && modules.notes.captureSnapshot(lookup.note);
		let fingerprint = source.fingerprint;
		let saved = await modules.notes.persistSummary({
			zotero: global.Zotero,
			attachment,
			summary: validation.value,
			validationResult: validation,
			sources: [source],
			provider: preview.provider,
			model: preview.model,
			promptVersion: modules.prompts.PROMPT_VERSION,
			sourceFingerprint: fingerprint,
			expectedNoteSnapshot: snapshot,
			storedManagedHash: lookup.note ? modules.notes.extractManagedSection(lookup.note.getNote?.() || "").hash : null,
			getCurrentSourceFingerprint: async () => currentFingerprint(attachment, source),
		});
		onProgress?.({ stage: "saving-note", percent: 100 });
		return {
			ok: true,
			text: modules.validation.safePlainText(validation.value, { kind: "summary" }),
			summary: validation.value,
			saved: safePersistence(saved),
			provider: preview.provider,
			model: preview.model,
			citationsValidated: true,
		};
	}

	async function runExplanation({ context, preview, signal, onDelta, onProgress }) {
		let source = {
			title: context?.title || "PDF",
			selectedPageLabel: context?.pageLabel || "",
			pages: [pageForSelection({
				pageIndex: context?.pageIndex,
				pageLabel: context?.pageLabel,
				selectedText: context?.selectionText,
			})],
		};
		let question = context?.question || "Explain this simply.";
		let prompt = modules.prompts.buildExplanationPrompt({
			source,
			selectedText: context?.selectionText,
			surroundingText: context?.surroundingText,
			question,
			mode: context?.mode || "simple",
			outputBudget: 600,
		});
		onProgress?.({ stage: "analysing-selection", percent: 20 });
		let streamed = await streamJSON(prompt, preview, { signal, onDelta, maxOutputTokens: 600 });
		let parsed = modules.validation.parseStructuredResponse(streamed.text);
		if (parsed.errors.length || !parsed.value || typeof parsed.value.answer !== "string") {
			return { ok: false, incomplete: true, text: streamed.text, reason: "invalid-explanation" };
		}
		let citations = modules.validation.validateCitations(parsed.value.citations || [], [source], {
			knownSourceIds: sourceIDs(source),
		});
		if (citations.errors.length) {
			return { ok: false, incomplete: true, text: parsed.value.answer, reason: "invalid-citation" };
		}
		onProgress?.({ stage: "validating-citations", percent: 100 });
		return { ok: true, text: parsed.value.answer, answer: parsed.value.answer, citations: citations.values, question };
	}

	async function runCrossCheck({ context, preview, signal, onProgress, onDelta }) {
		let scope = await modules.crosscheck.planCollectionScope(context?.collectionID, {
			zotero: global.Zotero,
			limit: Math.min(100, Number(context?.limit) || 25),
			hardLimit: 100,
		});
		let dossierOptions = {
			signal,
			concurrency: 2,
			promptVersion: modules.prompts.PROMPT_VERSION,
			extract: attachment => extract(attachment, { signal }),
			buildDossier: async ({ attachment, source }) => ({
				sourceKey: attachment.key,
				title: source.title,
				fingerprint: source.fingerprint,
				source,
				sourceIds: sourceIDs(source),
				evidence: source.pages.slice(0, 12).map(page => ({
					claim: text(page.text).slice(0, 2000),
					citations: [{ sourceId: page.sourceId, page: page.pageNumber }],
				})),
			}),
			synthesize: async ({ dossiers }) => {
				onProgress?.({ stage: "synthesising", percent: 80 });
				let prompt = modules.prompts.buildCrosscheckPrompt({ dossiers, scope: context?.collectionName || "selected collection" });
				let streamed = await streamJSON(prompt, preview, { signal, onDelta, maxOutputTokens: 2400 });
				return streamed.text;
			},
		};
		onProgress?.({ stage: "analysing-chunks", percent: 15 });
		let result = await modules.crosscheck.runCrosscheck({ ...dossierOptions, scope });
		if (!result.ok) {
			return {
				ok: false,
				reason: text(result.reason).slice(0, 120),
				cancelled: Boolean(result.cancelled),
				warnings: Array.isArray(result.scope?.warnings)
					? result.scope.warnings.map(value => text(value?.code || value)).slice(0, 20) : [],
				estimate: result.estimate || modules.crosscheck.estimateScope(scope),
			};
		}
		let saved = await modules.crosscheck.persistCrosscheckReport({
			zotero: global.Zotero,
			collection: global.Zotero?.Collections?.get?.(context?.collectionID) || { id: context?.collectionID, name: context?.collectionName },
			report: result.report,
			sources: result.processed.dossiers,
			provider: preview.provider,
			model: preview.model,
		});
		onProgress?.({ stage: "saving-note", percent: 100 });
		return {
			ok: true,
			text: modules.validation.safePlainText(result.report, { kind: "crosscheck" }),
			report: result.report,
			saved: safePersistence(saved),
			estimate: result.estimate,
			warnings: result.warnings,
			citationsValidated: Boolean(result.validation?.ok !== false),
		};
	}

	const operations = {
		async prepareSummary(options) { return prepareSummary(options || {}); },
		async prepareExplanation(options) { return prepareExplanation(options || {}); },
		async prepareCrossCheck(options) { return prepareCrossCheck(options || {}); },
		async runSummary(options) { return runSummary(options || {}); },
		async runExplanation(options) { return runExplanation(options || {}); },
		async runCrossCheck(options) { return runCrossCheck(options || {}); },
		initialize() {},
	};

	modules.operations = operations;
	modules.orchestrator = operations;
})(globalThis);
