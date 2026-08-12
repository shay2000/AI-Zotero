(function (global) {
	"use strict";

	const modules = global.__AIZoteroModules || (global.__AIZoteroModules = {});

	const DEFAULT_LIMIT = 25;
	const HARD_LIMIT = 100;
	const MAX_CONCURRENCY = 2;

	function asString(value) {
		return value === null || value === undefined ? "" : String(value);
	}

	function safeText(value) {
		let text = asString(value);
		try { text = text.normalize("NFC"); } catch (e) { /* keep text */ }
		return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
	}

	function collectionID(collection) {
		return collection?.id ?? collection?.collectionID ?? collection?.key ?? collection;
	}

	function collectionName(collection) {
		return safeText(collection?.name || collection?.title || collection?.key || collectionID(collection) || "Collection");
	}

	function itemKey(item) {
		return `${item?.libraryID ?? ""}:${item?.key ?? item?.id ?? item?.itemID ?? ""}`;
	}

	function isDeleted(item) {
		if (!item) return true;
		if (item.deleted || item.trashed) return true;
		if (typeof item.isInTrash === "function") {
			try { return Boolean(item.isInTrash()); } catch (e) { return true; }
		}
		return false;
	}

	function isPDF(attachment) {
		if (typeof attachment?.isAttachment === "function" && !attachment.isAttachment()) return false;
		if (typeof attachment?.isRegularItem === "function" && attachment.isRegularItem()) return false;
		if (modules.extraction?.isPDFAttachment) return modules.extraction.isPDFAttachment(attachment);
		if (typeof attachment?.isPDFAttachment === "function") return Boolean(attachment.isPDFAttachment());
		return attachment?.attachmentContentType === undefined
			|| attachment?.attachmentContentType === "application/pdf"
			|| /\.pdf$/i.test(asString(attachment?.filename || attachment?.path));
	}

	async function maybeArray(value) {
		let result = await value;
		return Array.isArray(result) ? result : [];
	}

	async function getChildren(collection, options, zotero) {
		if (typeof options.getChildCollections === "function") {
			return maybeArray(options.getChildCollections(collection));
		}
		if (typeof collection?.getChildCollections === "function") {
			return maybeArray(collection.getChildCollections(false));
		}
		if (Array.isArray(collection?.children)) return collection.children.slice();
		if (zotero?.Collections) {
			if (typeof zotero.Collections.getByParent === "function") {
				return maybeArray(zotero.Collections.getByParent(collectionID(collection), true));
			}
			if (typeof zotero.Collections.getChildCollections === "function") {
				return maybeArray(zotero.Collections.getChildCollections(collectionID(collection)));
			}
		}
		return [];
	}

	async function getItems(collection, options, zotero) {
		if (typeof options.getCollectionItems === "function") {
			return maybeArray(options.getCollectionItems(collection));
		}
		if (typeof collection?.getChildItems === "function") {
			return maybeArray(collection.getChildItems(true));
		}
		if (Array.isArray(collection?.items)) return collection.items.slice();
		if (zotero?.Items && typeof zotero.Items.getByCollection === "function") {
			return maybeArray(zotero.Items.getByCollection(collectionID(collection), true));
		}
		return [];
	}

	async function resolveCollection(root, options, zotero) {
		if (root && typeof root === "object") return root;
		if (typeof options.getCollection === "function") return options.getCollection(root);
		if (zotero?.Collections?.get) return zotero.Collections.get(root);
		return root ? { id: root, key: root, name: String(root) } : null;
	}

	async function traverseCollectionSubtreeDetailed(root, options = {}) {
		let zotero = options.zotero || global.Zotero || {};
		let resolvedRoot = await resolveCollection(root, options, zotero);
		let collections = [];
		let paths = new Map();
		let visited = new Set();
		let cycleWarnings = [];
		async function visit(collection, parentPath) {
			if (!collection) return;
			if (collection.deleted || collection.trashed) return;
			let id = collectionID(collection);
			let visitKey = `${collection?.libraryID ?? ""}:${id}`;
			if (visited.has(visitKey)) {
				cycleWarnings.push({ code: "collection-cycle-or-duplicate", collectionID: id });
				return;
			}
			visited.add(visitKey);
			let path = parentPath.concat(collectionName(collection));
			collections.push(collection);
			paths.set(visitKey, path);
		let children = await getChildren(collection, options, zotero);
		for (let child of children) {
			let resolvedChild = await resolveCollection(child, options, zotero);
			await visit(resolvedChild, path);
		}
		}
		await visit(resolvedRoot, []);
		return { collections, paths, warnings: cycleWarnings };
	}

	async function traverseCollectionSubtree(root, options = {}) {
		let result = await traverseCollectionSubtreeDetailed(root, options);
		// Keep the convenient array return shape while exposing diagnostics for
		// callers that need to show collection paths in the preview.
		result.collections.paths = result.paths;
		result.collections.warnings = result.warnings;
		return result.collections;
	}

	function pathFor(collection, paths) {
		let id = collectionID(collection);
		let key = `${collection?.libraryID ?? ""}:${id}`;
		return paths.get(key) || [collectionName(collection)];
	}

	async function resolveItem(item, options, zotero) {
		if (typeof item === "object") return item;
		if (typeof options.getItem === "function") return options.getItem(item);
		if (zotero?.Items?.getAsync) return zotero.Items.getAsync(item);
		if (zotero?.Items?.get) return zotero.Items.get(item);
		return null;
	}

	async function itemAttachments(item, options, zotero) {
		let values;
		if (typeof options.getItemAttachments === "function") values = await options.getItemAttachments(item);
		else if (typeof item?.getAttachments === "function") values = await item.getAttachments(true);
		else values = item?.attachments || item?.attachmentItems || [];
		let list = Array.isArray(values) ? values : [];
		let resolved = [];
		for (let value of list) {
			let attachment = await resolveItem(value, options, zotero);
			if (attachment) resolved.push(attachment);
		}
		return resolved;
	}

	async function attachmentAvailable(attachment, options) {
		if (attachment.fileExists === false || attachment.missing === true) {
			return { ok: false, reason: "file-missing" };
		}
		if (typeof options.fileAvailable === "function") {
			try {
				return (await options.fileAvailable(attachment))
					? { ok: true } : { ok: false, reason: "file-missing" };
			}
			catch (e) {
				return { ok: false, reason: "file-inaccessible" };
			}
		}
		if (typeof attachment.getFilePathAsync === "function") {
			try {
				let path = await attachment.getFilePathAsync();
				if (!path) return { ok: false, reason: "file-missing" };
			}
			catch (e) {
				return { ok: false, reason: "file-inaccessible" };
			}
		}
		if (attachment.attachmentLinkMode === "linked_file" && !attachment.path && !attachment.attachmentPath) {
			return { ok: false, reason: "linked-file-inaccessible" };
		}
		return { ok: true };
	}

	function addCandidate(map, attachment, paths) {
		let key = itemKey(attachment);
		let existing = map.get(key);
		let collectionPaths = paths.map(path => path.slice());
		if (existing) {
			for (let path of collectionPaths) {
				if (!existing.collectionPaths.some(value => value.join("/") === path.join("/"))) {
					existing.collectionPaths.push(path);
				}
			}
			return existing;
		}
		let candidate = {
			attachment,
			attachmentID: attachment.id ?? attachment.itemID,
			libraryID: attachment.libraryID,
			attachmentKey: attachment.key,
			parentItemID: attachment.parentID || attachment.parentItemID || null,
			title: safeText(attachment.title || attachment.filename || attachment.key || "PDF"),
			collectionPaths,
			pageCount: attachment.pageCount || attachment.totalPages || null,
			charCount: attachment.charCount || null,
			existingSummaryFreshness: attachment.existingSummaryFreshness || null,
		};
		map.set(key, candidate);
		return candidate;
	}

	async function collectPDFAttachments(root, options = {}) {
		let zotero = options.zotero || global.Zotero || {};
		let tree = await traverseCollectionSubtreeDetailed(root, options);
		let candidates = new Map();
		let excluded = [];
		for (let collection of tree.collections) {
			let path = pathFor(collection, tree.paths);
			let items = await getItems(collection, options, zotero);
			for (let rawItem of items) {
				let item = await resolveItem(rawItem, options, zotero);
				if (!item || isDeleted(item)) {
					excluded.push({ item: rawItem, reason: "trashed-or-missing-item" });
					continue;
				}
				let attachments = [];
				if (isPDF(item) && (item.isAttachment?.() !== false || item.attachmentContentType)) {
					attachments.push(item);
				}
				else if (typeof item.isRegularItem !== "function" || item.isRegularItem()) {
					attachments.push(...await itemAttachments(item, options, zotero));
				}
				for (let attachment of attachments) {
					if (isDeleted(attachment)) {
						excluded.push({ item: attachment, reason: "trashed-or-missing-item" });
						continue;
					}
					if (!isPDF(attachment)) {
						excluded.push({ item: attachment, reason: "unsupported-attachment-type" });
						continue;
					}
					let availability = await attachmentAvailable(attachment, options);
					if (!availability.ok) {
						excluded.push({ item: attachment, reason: availability.reason });
						continue;
					}
					addCandidate(candidates, attachment, [path]);
				}
			}
		}
		return {
			root,
			collections: tree.collections,
			candidates: Array.from(candidates.values()),
			excluded,
			warnings: tree.warnings,
		};
	}

	function selectScope(candidates = [], options = {}) {
		let hardLimit = Math.max(1, Math.floor(options.hardLimit || HARD_LIMIT));
		let requestedLimit = options.limit === undefined ? DEFAULT_LIMIT : Math.floor(Number(options.limit));
		if (!Number.isFinite(requestedLimit) || requestedLimit < 1) requestedLimit = DEFAULT_LIMIT;
		let hardLimitExceeded = candidates.length > hardLimit || requestedLimit > hardLimit;
		let safeLimit = Math.min(requestedLimit, hardLimit);
		let selected = candidates.slice(0, safeLimit);
		return {
			selected,
			remaining: candidates.slice(safeLimit),
			totalCandidates: candidates.length,
			limit: safeLimit,
			defaultLimit: DEFAULT_LIMIT,
			hardLimit,
			hardLimitExceeded,
			requiresCostWarning: selected.length > DEFAULT_LIMIT || candidates.length > DEFAULT_LIMIT,
			canRun: !hardLimitExceeded,
		};
	}

	async function planCollectionScope(root, options = {}) {
		let gathered = await collectPDFAttachments(root, options);
		return Object.assign(gathered, selectScope(gathered.candidates, options));
	}

	function estimateScope(scope) {
		let selected = scope?.selected || scope?.candidates || [];
		let chars = selected.reduce((sum, item) => sum + (Number(item.charCount) || 0), 0);
		let pages = selected.reduce((sum, item) => sum + (Number(item.pageCount) || 0), 0);
		let estimator = modules.chunking?.estimateTokens;
		return {
			files: selected.length,
			pages,
			characters: chars,
			estimatedInputTokens: estimator
				? Math.ceil(estimator("x".repeat(Math.min(chars, 100000))) * (chars > 100000 ? chars / 100000 : 1))
				: Math.ceil(chars / 4),
			estimatedRequests: selected.length + (selected.length ? 1 : 0),
		};
	}

	function isCurrentDossier(dossier, fingerprint, promptVersion) {
		if (!dossier || !fingerprint) return false;
		let dossierFingerprint = dossier.fingerprint || dossier.sourceFingerprint || dossier.source?.fingerprint;
		let dossierPromptVersion = dossier.promptVersion || dossier.schemaVersion;
		return dossierFingerprint === fingerprint && (!promptVersion || dossierPromptVersion === promptVersion);
	}

	function checkAbort(signal) {
		if (signal?.aborted) {
			let error = new Error("Cross-check cancelled");
			error.name = "AbortError";
			throw error;
		}
	}

	async function buildOneDossier(candidate, options) {
		checkAbort(options.signal);
		let attachment = candidate.attachment || candidate;
		let fingerprint = candidate.fingerprint || attachment.fingerprint || attachment.sourceFingerprint || null;
		if (typeof options.getSourceFingerprint === "function") fingerprint = await options.getSourceFingerprint(attachment);
		let promptVersion = options.promptVersion || modules.prompts?.PROMPT_VERSION || null;
		if (typeof options.getCanonicalDossier === "function") {
			let cached = await options.getCanonicalDossier(attachment);
			let current = typeof options.isDossierCurrent === "function"
				? await options.isDossierCurrent(cached, { fingerprint, promptVersion })
				: isCurrentDossier(cached, fingerprint, promptVersion);
			if (cached && current) return Object.assign({}, cached, { reused: true, ephemeral: false });
		}
		let source;
		if (typeof options.extract === "function") source = await options.extract(attachment);
		else if (modules.extraction?.extractDocument) source = await modules.extraction.extractDocument(attachment, options.extractionOptions || {});
		checkAbort(options.signal);
		let dossier;
		if (typeof options.buildDossier === "function") {
			dossier = await options.buildDossier({ attachment, source, candidate, signal: options.signal });
		}
		else if (typeof options.dossier === "function") {
			dossier = await options.dossier({ attachment, source, candidate, signal: options.signal });
		}
		else {
			dossier = {
				sourceKey: candidate.attachmentKey || attachment.key,
				title: candidate.title || attachment.title,
				fingerprint: source?.fingerprint || fingerprint,
				promptVersion,
				sourceIds: source?.pages?.map(page => page.sourceId) || [],
				evidence: [],
			};
		}
		return Object.assign({}, dossier || {}, {
			sourceKey: dossier?.sourceKey || candidate.attachmentKey || attachment.key,
			fingerprint: dossier?.fingerprint || source?.fingerprint || fingerprint,
			promptVersion: dossier?.promptVersion || promptVersion,
			ephemeral: true,
			reused: false,
		});
	}

	async function processDossiers(candidates, options = {}) {
		let values = Array.isArray(candidates) ? candidates : [];
		let concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency || MAX_CONCURRENCY)));
		let results = new Array(values.length);
		let next = 0;
		async function worker() {
			while (true) {
				checkAbort(options.signal);
				let index = next++;
				if (index >= values.length) return;
				try {
					results[index] = { ok: true, candidate: values[index], dossier: await buildOneDossier(values[index], options) };
				}
				catch (error) {
					if (error?.name === "AbortError") throw error;
					results[index] = { ok: false, candidate: values[index], reason: "dossier-failed" };
				}
			}
		}
		try {
			await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
		}
		catch (error) {
			if (error?.name === "AbortError") return { cancelled: true, results: results.filter(Boolean) };
			throw error;
		}
		return {
			cancelled: false,
			results,
			dossiers: results.filter(result => result?.ok).map(result => result.dossier),
			failures: results.filter(result => result && !result.ok),
		};
	}

	function classifyThemes(themes) {
		return (Array.isArray(themes) ? themes : []).map(theme => {
			let sourceKeys = theme.sourceKeys || theme.sources || theme.sourceIds || [];
			let unique = Array.from(new Set(sourceKeys.map(asString)));
			let classification = unique.length >= 2 ? "shared" : "unique";
			if (theme.classification === "disputed" || theme.classification === "contested") classification = "contested";
			return Object.assign({}, theme, { sourceKeys: unique, classification });
		});
	}

	async function runCrosscheck(options = {}) {
		if (options.signal?.aborted) return { ok: false, cancelled: true, reason: "cancelled" };
		let scope = options.scope;
		if (!scope || !scope.selected) {
			scope = await planCollectionScope(options.collection, options);
		}
		if (scope.hardLimitExceeded || !scope.canRun) {
			return { ok: false, reason: "hard-limit-exceeded", scope, estimate: estimateScope(scope) };
		}
		checkAbort(options.signal);
		let processed;
		try {
			processed = await processDossiers(scope.selected, options);
		}
		catch (error) {
			if (error?.name === "AbortError") return { ok: false, cancelled: true, reason: "cancelled", scope };
			return { ok: false, reason: "dossier-processing-failed", scope };
		}
		if (processed.cancelled) return { ok: false, cancelled: true, reason: "cancelled", scope, processed };
		let report = null;
		if (typeof options.synthesize === "function") {
			try {
				// Deliberately serial: all bounded dossier work completes before the
				// one synthesis request starts.
				report = await options.synthesize({ dossiers: processed.dossiers, scope, signal: options.signal });
			}
			catch (error) {
				return { ok: false, reason: "synthesis-failed", scope, processed };
			}
		}
		else if (options.report) {
			report = options.report;
		}
		let validation = null;
		if (report && modules.validation?.validateCrosscheck) {
			let sources = processed.dossiers.map(dossier => dossier.source || dossier);
			validation = await modules.validation.validateWithRepair(report, {
				kind: "crosscheck",
				sources,
				knownSourceIds: sources.flatMap(source => source.sourceIds || source.pages?.map(page => page.sourceId) || []),
				repair: options.repair,
				repairProvider: options.repairProvider,
			});
			if (!validation.ok) {
				return { ok: false, reason: "invalid-report", scope, processed, validation };
			}
			report = validation.value;
		}
		return {
			ok: true,
			scope,
			estimate: estimateScope(scope),
			processed,
			report,
			validation,
			warnings: (scope.warnings || []).concat(processed.failures.map(() => ({ code: "dossier-failed" }))),
		};
	}

	async function persistCrosscheckReport(options = {}) {
		if (!modules.notes?.createCrosscheckReport) return { saved: false, reason: "notes-module-unavailable" };
		return modules.notes.createCrosscheckReport(options);
	}

	const api = {
		DEFAULT_LIMIT,
		HARD_LIMIT,
		MAX_CONCURRENCY,
		traverseCollectionSubtree,
		traverseCollectionSubtreeDetailed,
		collectPDFAttachments,
		gatherCollectionPDFs: collectPDFAttachments,
		collectCollectionPDFs: collectPDFAttachments,
		selectScope,
		planCollectionScope,
		estimateScope,
		isCurrentDossier,
		processDossiers,
		classifyThemes,
		runCrosscheck,
		crossCheckCollection: runCrosscheck,
		crossCheck: runCrosscheck,
		persistCrosscheckReport,
	};

	modules.crosscheck = api;
})(globalThis);
