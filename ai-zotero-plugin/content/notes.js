(function (global) {
	"use strict";

	const modules = global.__AIZoteroModules || (global.__AIZoteroModules = {});

	const RELATION_PREDICATE = "dc:relation";
	const SUMMARY_URN_PREFIX = "urn:ai-zotero:summary:";
	const PROVENANCE_URN_PREFIX = "urn:ai-zotero:provenance:v1:";
	const CROSSCHECK_URN_PREFIX = "urn:ai-zotero:crosscheck:v1:";
	const MANAGED_START = "<!-- AI-ZOTERO:MANAGED-START -->";
	const MANAGED_END = "<!-- AI-ZOTERO:MANAGED-END -->";
	const MANAGED_HASH_PREFIX = "<!-- AI-ZOTERO:MANAGED-HASH:";
	const MANAGED_HASH_SUFFIX = " -->";
	const PERSONAL_START = "<!-- AI-ZOTERO:PERSONAL-START -->";
	const PERSONAL_END = "<!-- AI-ZOTERO:PERSONAL-END -->";
	const METADATA_PREFIX = "<!-- AI-ZOTERO:METADATA:";
	const METADATA_SUFFIX = " -->";
	const ARTIFACT_SCHEMA_VERSION = 1;

	function asString(value) {
		return value === null || value === undefined ? "" : String(value);
	}

	function safeText(value) {
		let text = asString(value);
		try {
			text = text.normalize("NFC");
		}
		catch (e) {
			// Keep persistence available on older runtimes.
		}
		return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
	}

	function stableHash(value) {
		if (modules.extraction?.stableHash) {
			return modules.extraction.stableHash(value);
		}
		let text = safeText(value);
		let first = 2166136261;
		let second = 2654435761;
		for (let i = 0; i < text.length; i++) {
			let code = text.charCodeAt(i);
			first = Math.imul(first ^ code, 16777619) >>> 0;
			second = Math.imul(second ^ (code + i), 2246822519) >>> 0;
		}
		return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
	}

	function encodePart(value) {
		return encodeURIComponent(safeText(value));
	}

	function makeSummaryURN(libraryID, attachmentKey) {
		return `${SUMMARY_URN_PREFIX}${encodePart(libraryID)}:${encodePart(attachmentKey)}`;
	}

	function makeProvenanceURN(libraryID, attachmentKey) {
		return `${PROVENANCE_URN_PREFIX}${encodePart(libraryID)}:${encodePart(attachmentKey)}`;
	}

	function makeCrosscheckURN(libraryID, collectionKey, createdAt) {
		return `${CROSSCHECK_URN_PREFIX}${encodePart(libraryID)}:${encodePart(collectionKey)}:${encodePart(createdAt)}`;
	}

	function getNoteText(note) {
		if (!note) return "";
		if (typeof note.getNote === "function") return safeText(note.getNote());
		return safeText(note.note || "");
	}

	function setNoteText(note, content) {
		if (typeof note.setNote === "function") return note.setNote(content);
		note.note = content;
		return true;
	}

	function getDateValue(value) {
		if (value === null || value === undefined || value === "") return 0;
		if (typeof value === "number") return value;
		let parsed = Date.parse(String(value));
		return Number.isFinite(parsed) ? parsed : Number(value) || 0;
	}

	function getLibrary(zotero, item) {
		if (item?.library) return item.library;
		try {
			return item && zotero?.Libraries?.get ? zotero.Libraries.get(item.libraryID) : null;
		}
		catch (e) {
			return null;
		}
	}

	function isEditable(item, zotero) {
		if (!item) return false;
		if (item.isEditable === false || item.editable === false) return false;
		if (typeof item.isEditable === "function") {
			try {
				if (!item.isEditable()) return false;
			}
			catch (e) {
				return false;
			}
		}
		if (item.isReadOnly === true || item.readOnly === true) return false;
		let library = getLibrary(zotero, item);
		// `filesEditable` controls attachment file writes, not ordinary note writes.
		// A read-only group library is represented by `editable === false`.
		if (library && library.editable === false) {
			return false;
		}
		return true;
	}

	function captureSnapshot(note) {
		if (!note) return null;
		return {
			id: note.id ?? null,
			key: note.key ?? null,
			version: note.version ?? null,
			dateModified: note.dateModified ?? null,
			managedContentHash: extractManagedSection(getNoteText(note)).hash || null,
			noteHash: stableHash(getNoteText(note)),
		};
	}

	function snapshotsMatch(expected, actual) {
		if (!expected || !actual) return true;
		if (expected.id !== null && actual.id !== null && expected.id !== actual.id) return false;
		if (expected.key !== null && actual.key !== null && expected.key !== actual.key) return false;
		if (expected.version !== null && expected.version !== undefined
			&& actual.version !== null && actual.version !== undefined
			&& String(expected.version) !== String(actual.version)) return false;
		if (expected.dateModified !== null && expected.dateModified !== undefined
			&& actual.dateModified !== null && actual.dateModified !== undefined
			&& String(expected.dateModified) !== String(actual.dateModified)) return false;
		return true;
	}

	async function refreshNote(note, options = {}) {
		if (typeof options.reloadNote === "function") {
			let refreshed = await options.reloadNote(note);
			return refreshed || note;
		}
		if (options.reload !== false && typeof note?.reload === "function") {
			try {
				await note.reload(["note", "relations"], true);
			}
			catch (e) {
				try {
					await note.reload();
				}
				catch (ignored) {
					// A stale in-memory object is checked again below.
				}
			}
		}
		return note;
	}

	function normalizeMetadata(metadata = {}, managedContentHash = "") {
		let sourceKeys = Array.isArray(metadata.sourceKeys)
			? metadata.sourceKeys.map(value => safeText(value).slice(0, 300)).filter(Boolean).slice(0, 100)
			: [];
		let sourceFingerprints = Array.isArray(metadata.sourceFingerprints)
			? metadata.sourceFingerprints.map(value => safeText(value).slice(0, 300)).filter(Boolean).slice(0, 100)
			: [];
		let kind = ["summary", "crosscheck", "saved-explanation"].includes(metadata.kind)
			? metadata.kind : "summary";
		let createdAt = safeText(metadata.createdAt || new Date().toISOString()).slice(0, 100);
		return {
			schemaVersion: Number.isInteger(metadata.schemaVersion) ? metadata.schemaVersion : ARTIFACT_SCHEMA_VERSION,
			kind,
			sourceKeys,
			sourceFingerprints,
			provider: safeText(metadata.provider).slice(0, 200),
			model: safeText(metadata.model).slice(0, 300),
			promptVersion: safeText(metadata.promptVersion).slice(0, 200),
			createdAt,
			updatedAt: safeText(metadata.updatedAt || createdAt).slice(0, 100),
			managedContentHash: safeText(managedContentHash || metadata.managedContentHash).slice(0, 200),
		};
	}

	function metadataComment(metadata) {
		try {
			return `${METADATA_PREFIX}${encodeURIComponent(JSON.stringify(metadata))}${METADATA_SUFFIX}`;
		}
		catch (e) {
			return "";
		}
	}

	function extractMetadata(content) {
		content = asString(content);
		let start = content.indexOf(METADATA_PREFIX);
		if (start < 0) return null;
		let valueStart = start + METADATA_PREFIX.length;
		let end = content.indexOf(METADATA_SUFFIX, valueStart);
		if (end < 0) return null;
		try {
			let parsed = JSON.parse(decodeURIComponent(content.slice(valueStart, end)));
			return normalizeMetadata(parsed);
		}
		catch (e) {
			return null;
		}
	}

	function extractManagedSection(content) {
		content = asString(content);
		let metadata = extractMetadata(content);
		let start = content.indexOf(MANAGED_START);
		let end = content.indexOf(MANAGED_END);
		if (start < 0 || end < start) {
			return { present: false, body: "", hash: null, personal: null, metadata };
		}
		let body = content.slice(start + MANAGED_START.length, end).trim();
		let hashMatch = new RegExp(`${escapeRegExp(MANAGED_HASH_PREFIX)}([a-f0-9]+)${escapeRegExp(MANAGED_HASH_SUFFIX)}`).exec(body);
		let hash = hashMatch ? hashMatch[1] : null;
		if (hashMatch) {
			body = `${body.slice(0, hashMatch.index)}${body.slice(hashMatch.index + hashMatch[0].length)}`.trim();
		}
		let personalStart = content.indexOf(PERSONAL_START, end + MANAGED_END.length);
		let personalEnd = personalStart < 0 ? -1 : content.indexOf(PERSONAL_END, personalStart + PERSONAL_START.length);
		let personal = personalStart >= 0 && personalEnd >= personalStart
			? content.slice(personalStart + PERSONAL_START.length, personalEnd).trim()
			: null;
		return { present: true, body, hash, personal, metadata };
	}

	function escapeRegExp(value) {
		return asString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function extractPersonalNotes(content) {
		let sections = extractManagedSection(content);
		return sections.personal;
	}

	function defaultPersonalSection() {
		return "<h2>Personal notes</h2>\n<p></p>";
	}

	function wrapManagedContent(managedContent, personalContent, metadata = {}) {
		let managed = safeText(managedContent).trim();
		let personal = personalContent === null || personalContent === undefined
			? defaultPersonalSection() : personalContent;
		let hash = stableHash(managed);
		let artifactMetadata = normalizeMetadata(metadata, hash);
		return [
			metadataComment(artifactMetadata),
			MANAGED_START,
			`${MANAGED_HASH_PREFIX}${hash}${MANAGED_HASH_SUFFIX}`,
			managed,
			MANAGED_END,
			PERSONAL_START,
			personal,
			PERSONAL_END,
		].join("\n");
	}

	function mergeManagedContent(existingContent, nextManagedContent, options = {}) {
		let existing = extractManagedSection(existingContent);
		if (!existing.present) {
			if (!asString(existingContent).trim()) {
				return { ok: true, content: wrapManagedContent(nextManagedContent, null, options.metadata), created: true };
			}
			return { ok: false, reason: "canonical-markers-missing", requiresReview: true };
		}
		if (existing.personal === null) {
			return { ok: false, reason: "personal-markers-missing", requiresReview: true };
		}
		let expectedHash = options.storedManagedHash || existing.hash;
		let actualHash = stableHash(existing.body);
		if (!expectedHash || expectedHash !== actualHash) {
			return {
				ok: false,
				reason: "managed-content-edited",
				requiresReview: true,
				expectedHash: expectedHash || null,
				actualHash,
			};
		}
		return {
			ok: true,
			content: wrapManagedContent(nextManagedContent, existing.personal,
				Object.assign({}, existing.metadata || {}, options.metadata || {}, { updatedAt: new Date().toISOString() })),
			created: false,
		};
	}

	function renderManaged(kind, result, options = {}) {
		let renderer = modules.renderer;
		if (!renderer) {
			throw new Error("AI renderer module is unavailable");
		}
		let metadata = {
			provider: safeText(options.provider),
			model: safeText(options.model),
			createdAt: safeText(options.createdAt || new Date().toISOString()),
			sourceFingerprint: safeText(options.sourceFingerprint || options.fingerprint),
		};
		let title = options.title || (kind === "crosscheck" ? "AI Cross-check" : "AI Summary");
		return kind === "crosscheck"
			? renderer.renderCrosscheck(result, { title, sources: options.sources, metadata })
			: renderer.renderSummary(result, { title, sources: options.sources, metadata });
	}

	async function findCanonicalNote(attachment, options = {}) {
		let zotero = options.zotero || global.Zotero || {};
		let libraryID = attachment?.libraryID;
		let attachmentKey = attachment?.key || attachment?.attachmentKey;
		let relationURN = options.relationURN || makeSummaryURN(libraryID, attachmentKey);
		let related = [];
		if (Array.isArray(options.relatedNotes)) {
			related = options.relatedNotes.slice();
		}
		else if (zotero.Relations && typeof zotero.Relations.getByPredicateAndObject === "function") {
			related = await zotero.Relations.getByPredicateAndObject("item", RELATION_PREDICATE, relationURN);
		}
		let valid = related.filter(note => {
			if (!note || note.deleted) return false;
			if (typeof note.isNote === "function" && !note.isNote()) return false;
			return note.libraryID === undefined || libraryID === undefined || note.libraryID === libraryID;
		});
		valid.sort((left, right) => {
			let date = getDateValue(right.dateModified) - getDateValue(left.dateModified);
			return date || (Number(right.version) || 0) - (Number(left.version) || 0);
		});
		return {
			note: valid[0] || null,
			notes: valid,
			duplicate: valid.length > 1,
			relationURN,
			warnings: valid.length > 1 ? ["duplicate-canonical-relations"] : [],
		};
	}

	function addRelation(note, predicate, object) {
		if (typeof note?.addRelation === "function") {
			note.addRelation(predicate, object);
			return;
		}
		if (!note.relations || typeof note.relations !== "object") note.relations = {};
		if (!Array.isArray(note.relations[predicate])) note.relations[predicate] = [];
		if (!note.relations[predicate].includes(object)) note.relations[predicate].push(object);
	}

	function removeRelation(note, predicate, object) {
		if (typeof note?.removeRelation === "function") {
			try { note.removeRelation(predicate, object); } catch (e) { /* best effort rollback */ }
			return;
		}
		if (Array.isArray(note?.relations?.[predicate])) {
			note.relations[predicate] = note.relations[predicate].filter(value => value !== object);
		}
	}

	function hasRelation(note, predicate, object) {
		if (typeof note?.getRelationsByPredicate === "function") {
			return (note.getRelationsByPredicate(predicate) || []).includes(object);
		}
		return Boolean(note?.relations?.[predicate]?.includes(object));
	}

	function setCollections(note, collectionIDs) {
		if (!Array.isArray(collectionIDs) || !collectionIDs.length) return;
		if (typeof note.setCollections === "function") note.setCollections(collectionIDs);
		else note.collections = collectionIDs.slice();
	}

	function attachmentCollections(attachment) {
		if (typeof attachment?.getCollections === "function") {
			try { return attachment.getCollections(true) || []; } catch (e) { return []; }
		}
		return Array.isArray(attachment?.collections) ? attachment.collections.slice() : [];
	}

	function makeNote(zotero, options) {
		if (typeof options.createNote === "function") return options.createNote();
		if (typeof zotero.Item === "function") return new zotero.Item("note");
		throw new Error("Zotero note factory is unavailable");
	}

	function noteParentID(attachment) {
		return attachment?.parentItemID || attachment?.parentID || null;
	}

	async function saveNote(note) {
		if (typeof note.saveTx === "function") return note.saveTx();
		if (typeof note.save === "function") return note.save();
		throw new Error("Zotero note save method is unavailable");
	}

	async function sourceStillCurrent(options) {
		if (typeof options.getCurrentSourceFingerprint !== "function" || !options.sourceFingerprint) return true;
		let current = await options.getCurrentSourceFingerprint();
		return safeText(current) === safeText(options.sourceFingerprint);
	}

	function staleResult(reason, extra = {}) {
		return Object.assign({ saved: false, stale: true, reason }, extra);
	}

	function cancelledResult() {
		return { saved: false, cancelled: true, reason: "cancelled", canCopy: true };
	}

	/**
	 * Create or update the ordinary Zotero note that is canonical for one PDF.
	 * The operation performs all checks before changing the note and uses the
	 * note's own saveTx() as the single persistence transaction.
	 */
	async function upsertSummaryNote(options = {}) {
		if (options.signal?.aborted) return cancelledResult();
		let attachment = options.attachment;
		if (!attachment) return { saved: false, reason: "missing-attachment" };
		let zotero = options.zotero || global.Zotero || {};
		let lookup = options.lookup || await findCanonicalNote(attachment, options);
		let note = options.note || lookup.note;
		let targetForEdit = note || attachment;
		if (!isEditable(targetForEdit, zotero)) {
			return {
				saved: false,
				reason: "read-only-library",
				canCopy: true,
				duplicate: lookup.duplicate,
			};
		}
		if (options.sourceFingerprint && !(await sourceStillCurrent(options))) {
			return staleResult("source-changed");
		}
		let expectedSnapshot = options.expectedNoteSnapshot || options.snapshot || null;
		if (note) {
			note = await refreshNote(note, options);
			let currentSnapshot = captureSnapshot(note);
			if (expectedSnapshot && !snapshotsMatch(expectedSnapshot, currentSnapshot)) {
				return staleResult("note-changed-during-generation", { currentSnapshot });
			}
		}
		let validationResult = options.validationResult;
		if (!validationResult && options.sources && modules.validation?.validateSummary) {
			validationResult = modules.validation.validateSummary(options.summary, options.sources, {
				knownSourceIds: options.knownSourceIds,
			});
		}
		if (validationResult && validationResult.ok === false) {
			return { saved: false, reason: "invalid-result", validation: validationResult, canCopy: true };
		}
		if (!options.summary && !validationResult?.value) {
			return { saved: false, reason: "missing-result", canCopy: true };
		}
		let kind = "summary";
		let title = options.title || `AI Summary — ${safeText(attachment.title || attachment.filename || "document")}`;
		let artifactMetadata = normalizeMetadata({
			schemaVersion: ARTIFACT_SCHEMA_VERSION,
			kind,
			sourceKeys: [attachment.key || attachment.attachmentKey],
			sourceFingerprints: [options.sourceFingerprint],
			provider: options.provider,
			model: options.model,
			promptVersion: options.promptVersion,
			createdAt: options.createdAt,
			updatedAt: new Date().toISOString(),
		});
		let managed;
		try {
			managed = renderManaged(kind, validationResult?.value || options.summary, Object.assign({}, options, { title }));
		}
		catch (e) {
			return { saved: false, reason: "render-failed", canCopy: true };
		}
		let content;
		let oldContent = note ? getNoteText(note) : "";
		if (note) {
			let merge = mergeManagedContent(oldContent, managed, {
				storedManagedHash: options.storedManagedHash,
				metadata: artifactMetadata,
			});
			if (!merge.ok) return Object.assign({ saved: false, canCopy: true }, merge);
			content = merge.content;
		}
		else {
			content = wrapManagedContent(managed, options.personalNotesHTML || null, artifactMetadata);
		}
		// Repeat the source check after rendering and immediately before the note
		// is mutated. Rendering can be expensive for a large report.
		if (options.signal?.aborted) return cancelledResult();
		if (options.sourceFingerprint && !(await sourceStillCurrent(options))) {
			return staleResult("source-changed");
		}
		if (!note) {
			try {
				note = makeNote(zotero, options);
				note.libraryID = attachment.libraryID;
				let parentID = noteParentID(attachment);
				if (parentID) note.parentID = parentID;
				else setCollections(note, attachmentCollections(attachment));
				if (typeof note.setField === "function") note.setField("title", title);
				else note.title = title;
			}
			catch (e) {
				return { saved: false, reason: "note-create-failed", canCopy: true };
			}
		}
		let provenanceURN = options.provenanceURN || makeProvenanceURN(attachment.libraryID, attachment.key || attachment.attachmentKey);
		let summaryURN = lookup.relationURN || makeSummaryURN(attachment.libraryID, attachment.key || attachment.attachmentKey);
		let addedRelations = [];
		let beforeText = getNoteText(note);
		try {
			setNoteText(note, content);
			if (!hasRelation(note, RELATION_PREDICATE, summaryURN)) {
				addRelation(note, RELATION_PREDICATE, summaryURN);
				addedRelations.push(summaryURN);
			}
			if (!hasRelation(note, RELATION_PREDICATE, provenanceURN)) {
				addRelation(note, RELATION_PREDICATE, provenanceURN);
				addedRelations.push(provenanceURN);
			}
			await saveNote(note);
		}
		catch (e) {
			try { setNoteText(note, beforeText); } catch (ignored) { /* preserve failure result */ }
			for (let relation of addedRelations) removeRelation(note, RELATION_PREDICATE, relation);
			return { saved: false, reason: "save-failed", canCopy: true };
		}
		return {
			saved: true,
			created: !lookup.note,
			note,
			content,
			relationURN: summaryURN,
			provenanceURN,
			managedContentHash: stableHash(managed),
			duplicate: lookup.duplicate,
			warnings: lookup.warnings,
		};
	}

	async function persistSummary(options) {
		return upsertSummaryNote(options);
	}

	async function createCrosscheckReport(options = {}) {
		if (options.signal?.aborted) return cancelledResult();
		let collection = options.collection || {};
		let zotero = options.zotero || global.Zotero || {};
		let sourceValues = Array.isArray(options.sources) ? options.sources : [];
		let artifactMetadata = normalizeMetadata({
			schemaVersion: ARTIFACT_SCHEMA_VERSION,
			kind: "crosscheck",
			sourceKeys: sourceValues.map(source => source?.sourceKey || source?.attachmentKey || source?.key),
			sourceFingerprints: sourceValues.map(source => source?.fingerprint || source?.sourceFingerprint),
			provider: options.provider,
			model: options.model,
			promptVersion: options.promptVersion,
			createdAt: options.createdAt,
			updatedAt: new Date().toISOString(),
		});
		let attachmentLike = {
			libraryID: collection.libraryID,
			key: collection.key || collection.collectionKey || collection.id,
			parentID: null,
			title: collection.name || "collection",
			collections: [collection.id].filter(Boolean),
			isEditable: collection.isEditable,
			library: collection.library,
		};
		let note = options.refreshExisting ? options.note : null;
		let title = options.title || `AI Cross-check — ${safeText(collection.name || "collection")} — ${safeText(options.date || new Date().toISOString().slice(0, 10))}`;
		let managed;
		let validationResult = options.validationResult;
		if (!validationResult && options.sources && modules.validation?.validateCrosscheck) {
			validationResult = modules.validation.validateCrosscheck(options.report, options.sources, {
				knownSourceIds: options.knownSourceIds,
			});
		}
		if (validationResult && validationResult.ok === false) {
			return { saved: false, reason: "invalid-result", validation: validationResult, canCopy: true };
		}
		if (!options.report && !validationResult?.value) {
			return { saved: false, reason: "missing-result", canCopy: true };
		}
		try {
			managed = renderManaged("crosscheck", options.report || validationResult?.value, Object.assign({}, options, { title }));
		}
		catch (e) {
			return { saved: false, reason: "render-failed", canCopy: true };
		}
		if (!note) {
			if (!isEditable(attachmentLike, zotero)) {
				return { saved: false, reason: "read-only-library", canCopy: true };
			}
			try {
				note = makeNote(zotero, options);
				note.libraryID = collection.libraryID;
				setCollections(note, [collection.id].filter(Boolean));
				if (typeof note.setField === "function") note.setField("title", title);
				else note.title = title;
			}
			catch (e) {
				return { saved: false, reason: "note-create-failed", canCopy: true };
			}
		}
		else if (!isEditable(note, zotero)) {
			return { saved: false, reason: "read-only-library", canCopy: true };
		}
		if (note && options.expectedNoteSnapshot && !snapshotsMatch(options.expectedNoteSnapshot, captureSnapshot(await refreshNote(note, options)))) {
			return staleResult("note-changed-during-generation");
		}
		let beforeText = getNoteText(note);
		if (options.signal?.aborted) return cancelledResult();
		let content = note && beforeText ? mergeManagedContent(beforeText, managed, {
				storedManagedHash: options.storedManagedHash,
				metadata: artifactMetadata,
		}) : { ok: true, content: wrapManagedContent(managed, null, artifactMetadata) };
		if (!content.ok) return Object.assign({ saved: false, canCopy: true }, content);
		let relationURN = makeCrosscheckURN(collection.libraryID, collection.key || collection.id, options.createdAt || new Date().toISOString());
		try {
			setNoteText(note, content.content);
			addRelation(note, RELATION_PREDICATE, relationURN);
			await saveNote(note);
		}
		catch (e) {
			try { setNoteText(note, beforeText); } catch (ignored) { /* atomicity best effort */ }
			return { saved: false, reason: "save-failed", canCopy: true };
		}
		return { saved: true, created: !options.refreshExisting, note, content: content.content, relationURN };
	}

	async function appendSavedExplanation(options = {}) {
		if (options.signal?.aborted) return cancelledResult();
		let note = options.note;
		if (!note) return { saved: false, reason: "missing-note" };
		if (!isEditable(note, options.zotero || global.Zotero || {})) return { saved: false, reason: "read-only-library", canCopy: true };
		let before = getNoteText(note);
		let snapshot = options.expectedNoteSnapshot;
		if (snapshot && !snapshotsMatch(snapshot, captureSnapshot(await refreshNote(note, options)))) {
			return staleResult("note-changed-during-generation");
		}
		let entry = [
			"<h3>Saved explanation</h3>",
			`<p><strong>Question:</strong> ${escapeHTML(options.question || "")}</p>`,
			`<p><strong>Quote:</strong> ${escapeHTML(options.quote || "")}</p>`,
			`<p>${escapeHTML(options.answer || "")}</p>`,
			`<p><em>${escapeHTML(options.pageLabel || "")}</em></p>`,
		].join("\n");
		let sections = extractManagedSection(before);
		if (!sections.present || !sections.personal) return { saved: false, reason: "canonical-markers-missing", canCopy: true };
		if (options.signal?.aborted) return cancelledResult();
		let personal = `${sections.personal}\n${entry}`;
		let managedBody = sections.body;
		let content = wrapManagedContent(managedBody, personal, Object.assign({}, sections.metadata || {}, {
			updatedAt: new Date().toISOString(),
		}));
		try {
			setNoteText(note, content);
			await saveNote(note);
		}
		catch (e) {
			try { setNoteText(note, before); } catch (ignored) { /* keep failure atomic */ }
			return { saved: false, reason: "save-failed", canCopy: true };
		}
		return { saved: true, note, content };
	}

	async function resolveItem(options = {}, zotero = global.Zotero || {}) {
		if (options.item) return options.item;
		let id = options.itemID || options.attachmentID;
		try {
			if (id && typeof zotero.Items?.getAsync === "function") return await zotero.Items.getAsync(id);
			if (id && typeof zotero.Items?.get === "function") return zotero.Items.get(id);
		}
		catch (e) {
			return null;
		}
		return null;
	}

	async function saveExplanation(options = {}) {
		if (options.signal?.aborted) return cancelledResult();
		let zotero = options.zotero || global.Zotero || {};
		let item = await resolveItem(options, zotero);
		let note = options.note;
		if (!note && item) {
			let lookup = await findCanonicalNote(item, { zotero });
			note = lookup.note;
		}
		if (!note) return { saved: false, reason: "missing-summary-note", canCopy: true };
		return appendSavedExplanation(Object.assign({}, options, { note, zotero }));
	}

	async function getSummaryState(options = {}) {
		let zotero = options.zotero || global.Zotero || {};
		let item = await resolveItem(options, zotero);
		if (!item) return { status: "source-missing", warnings: [] };
		let lookup = await findCanonicalNote(item, { zotero });
		if (!lookup.note) {
			return {
				status: "not-generated",
				warnings: lookup.warnings || [],
				noteID: null,
			};
		}
		let sections = extractManagedSection(getNoteText(lookup.note));
		let metadata = sections.metadata || {};
		let warnings = (lookup.warnings || []).slice();
		if (!sections.present || !sections.body) warnings.push("managed-content-missing");
		return {
			status: sections.present && sections.body ? "current" : "stale",
			provider: metadata.provider || "",
			model: metadata.model || "",
			updatedAt: getDateValue(metadata.updatedAt || lookup.note.dateModified),
			warnings,
			noteID: Number.isInteger(lookup.note.id) ? lookup.note.id : null,
			text: sections.body || "",
		};
	}

	async function openNote(options = {}) {
		let noteID = Number.isInteger(options) ? options : options.noteID;
		if (!Number.isInteger(noteID)) return false;
		try {
			if (typeof global.ZoteroPane?.selectItem === "function") {
				await global.ZoteroPane.selectItem(noteID);
				return true;
			}
			if (typeof global.Zotero?.getMainWindow === "function") {
				let window = global.Zotero.getMainWindow();
				if (typeof window?.ZoteroPane?.selectItem === "function") {
					await window.ZoteroPane.selectItem(noteID);
					return true;
				}
			}
		}
		catch (e) {
			return false;
		}
		return false;
	}

	function escapeHTML(value) {
		return safeText(value)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	}

	const api = {
		RELATION_PREDICATE,
		SUMMARY_URN_PREFIX,
		PROVENANCE_URN_PREFIX,
			MANAGED_START,
			MANAGED_END,
			PERSONAL_START,
			PERSONAL_END,
			ARTIFACT_SCHEMA_VERSION,
		makeSummaryURN,
		makeProvenanceURN,
		makeCrosscheckURN,
		stableHash,
		captureSnapshot,
		snapshotsMatch,
		cancelledResult,
		extractManagedSection,
		extractMetadata,
	normalizeMetadata,
		extractPersonalNotes,
		wrapManagedContent,
		mergeManagedContent,
		findCanonicalNote,
		getCanonicalNote: findCanonicalNote,
		upsertSummaryNote,
		upsertCanonicalSummary: upsertSummaryNote,
		saveSummaryNote: upsertSummaryNote,
		persistSummary,
			createCrosscheckReport,
			appendSavedExplanation,
			saveExplanation,
			getSummaryState,
			openNote,
			isEditable,
	};

	modules.notes = api;
})(globalThis);
