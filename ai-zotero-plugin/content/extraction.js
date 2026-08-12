(function (global) {
	"use strict";

	const modules = global.__AIZoteroModules || (global.__AIZoteroModules = {});

	const EXTRACTION_SCHEMA_VERSION = "pdf-extraction-v1";
	const SOURCE_ID_PATTERN = /^S(\d+)-P(\d+)$/;

	function isObject(value) {
		return value !== null && typeof value === "object";
	}

	function asString(value) {
		if (value === null || value === undefined) {
			return "";
		}
		return String(value);
	}

	function safeUnicode(value) {
		let text = asString(value);
		try {
			text = text.normalize("NFC");
		}
		catch (e) {
			// Older Gecko versions can lack String#normalize for unusual input.
		}
		return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
	}

	/**
	 * Normalize text inside one page. Page records are normalized separately so
	 * whitespace normalization can never join two PDF pages.
	 */
	function normalizeText(value) {
		let text = safeUnicode(value).replace(/\r\n?/g, "\n");
		text = text.split("\n").map(line => line
			.replace(/[\t\f\v ]+/g, " ")
			.trim()).join("\n");
		return text.replace(/\n{3,}/g, "\n\n").trim();
	}

	function positiveInteger(value, fallback) {
		let number = Number(value);
		return Number.isInteger(number) && number > 0 ? number : fallback;
	}

	function pad(number, width) {
		return String(number).padStart(width, "0");
	}

	/**
	 * Build the immutable local source identifier used in citations. Both
	 * parameters are one-based: section 3, page 14 becomes S03-P014.
	 */
	function makeSourceId(sectionNumber, pageNumber) {
		if (isObject(sectionNumber)) {
			pageNumber = sectionNumber.pageNumber ?? sectionNumber.page ?? sectionNumber.number;
			sectionNumber = sectionNumber.sectionNumber ?? sectionNumber.section ?? 1;
		}
		let section = positiveInteger(sectionNumber, 1);
		let page = positiveInteger(pageNumber, 1);
		return `S${pad(section, 2)}-P${pad(page, 3)}`;
	}

	function parseSourceId(sourceId) {
		let match = SOURCE_ID_PATTERN.exec(asString(sourceId));
		if (!match) {
			return null;
		}
		return {
			sourceId: match[0],
			sectionNumber: Number(match[1]),
			pageNumber: Number(match[2]),
		};
	}

	/**
	 * A small deterministic hash is deliberately kept synchronous for use in
	 * note edit markers. It is not used as a security primitive; it only detects
	 * accidental or concurrent content changes.
	 */
	function stableHash(value) {
		let text = safeUnicode(value);
		let first = 2166136261;
		let second = 2654435761;
		for (let i = 0; i < text.length; i++) {
			let code = text.charCodeAt(i);
			first ^= code;
			first = Math.imul(first, 16777619) >>> 0;
			second ^= code + i;
			second = Math.imul(second, 2246822519) >>> 0;
		}
		return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
	}

	function computeFingerprint(input = {}, schemaVersion, pageRecords) {
		if (typeof input !== "object" || input === null || Array.isArray(input)) {
			input = {
				attachmentHash: input,
				extractionSchemaVersion: schemaVersion || EXTRACTION_SCHEMA_VERSION,
				pages: pageRecords,
			};
		}
		let {
			attachmentHash,
			extractionSchemaVersion = EXTRACTION_SCHEMA_VERSION,
			pages,
			contentHash,
		} = input;
		let source = `${extractionSchemaVersion}|${asString(attachmentHash)}`;
		if (!attachmentHash) {
			let pageText = Array.isArray(pages)
				? pages.map(page => `${page.sourceId || ""}\n${page.text || ""}`).join("\n\f\n")
				: "";
			source += `|${contentHash || stableHash(pageText)}`;
		}
		return `${extractionSchemaVersion}:${stableHash(source)}`;
	}

	function sourceFingerprint(input = {}, schemaVersion, pageRecords) {
		return computeFingerprint(input, schemaVersion, pageRecords);
	}

	function warning(code, capability) {
		let value = { code: asString(code) };
		if (capability) {
			value.capability = asString(capability);
		}
		return value;
	}

	function looksLikeHeading(line) {
		let text = asString(line).trim();
		if (!text || text.length > 180 || /[.!?。！？]$/.test(text)) {
			return false;
		}
		if (/^(abstract|introduction|background|methods?|results?|discussion|conclusion|references?)$/i.test(text)) {
			return true;
		}
		let words = text.split(/\s+/).filter(Boolean);
		let uppercaseWords = words.filter(word => /[A-ZÀ-ÖØ-Þ]/.test(word) && !/[a-zà-öø-ÿ]/.test(word));
		return words.length <= 12 && uppercaseWords.length >= Math.max(1, Math.ceil(words.length * 0.6));
	}

	function normalizeHeadings(page, text) {
		if (Array.isArray(page.headings)) {
			return page.headings.map(heading => normalizeText(heading)).filter(Boolean);
		}
		return text.split("\n").filter(looksLikeHeading).slice(0, 12);
	}

	function normalizePage(page, index, defaultSection) {
		page = isObject(page) ? page : { text: page };
		let pageNumber = positiveInteger(
			page.pageNumber ?? page.page ?? page.number,
			index + 1
		);
		let sectionNumber = positiveInteger(
			page.sectionNumber ?? page.section ?? page.sectionIndex,
			defaultSection
		);
		let parsed = parseSourceId(page.sourceId || page.sourceID);
		if (parsed) {
			sectionNumber = parsed.sectionNumber;
			pageNumber = parsed.pageNumber;
		}
		let text = normalizeText(page.text ?? page.content ?? page.value ?? "");
		let sourceId = parsed ? parsed.sourceId : makeSourceId(sectionNumber, pageNumber);
		let label = normalizeText(page.label ?? page.pageLabel ?? String(pageNumber));
		let normalized = {
			sourceId,
			id: sourceId,
			pageNumber,
			pageIndex: Math.max(0, pageNumber - 1),
			sectionNumber,
			label: label || String(pageNumber),
			text,
			charCount: text.length,
			headings: normalizeHeadings(page, text),
		};
		if (Array.isArray(page.sections)) {
			normalized.sections = page.sections.map(section => {
				if (!isObject(section)) {
					return { title: normalizeText(section) };
				}
				return {
					id: section.id || makeSourceId(section.sectionNumber || section.number || sectionNumber, pageNumber),
					title: normalizeText(section.title || section.heading || ""),
					text: normalizeText(section.text || ""),
				};
			}).filter(section => section.title || section.text);
		}
		return normalized;
	}

	function splitPageText(text) {
		return safeUnicode(text).split(/\f/).map(value => ({ text: value }));
	}

	function extractPageArray(result) {
		if (!result) {
			return [];
		}
		if (Array.isArray(result)) {
			return result;
		}
		if (Array.isArray(result.pages)) {
			return result.pages;
		}
		if (Array.isArray(result.pageTexts)) {
			return result.pageTexts.map((text, index) => ({ text, pageNumber: index + 1 }));
		}
		if (result.document && Array.isArray(result.document.pages)) {
			return result.document.pages;
		}
		let text = result.text ?? result.fullText ?? result.content;
		return text === undefined || text === null ? [] : splitPageText(text);
	}

	function normalizeExtractionResult(attachment, result, options = {}) {
		let pages = extractPageArray(result);
		let defaultSection = positiveInteger(options.defaultSection, 1);
		let normalizedPages = pages.map((page, index) => normalizePage(page, index, defaultSection));
		let warnings = Array.isArray(options.warnings) ? options.warnings.slice() : [];
		let explicitPages = Array.isArray(result) || Array.isArray(result?.pages)
			|| Array.isArray(result?.pageTexts) || Array.isArray(result?.document?.pages);
		if (normalizedPages.length === 1 && (!explicitPages || !normalizedPages[0].sourceId.includes("P001"))) {
			warnings.push(warning("page-boundaries-unavailable", options.method));
		}
		if (!normalizedPages.length || !normalizedPages.some(page => page.text)) {
			warnings.push(warning("no-extracted-text", options.method));
		}
		let attachmentHash = options.attachmentHash || attachment?.attachmentHash || attachment?.sourceHash || "";
		let fingerprint = computeFingerprint({
			attachmentHash,
			extractionSchemaVersion: options.extractionSchemaVersion || EXTRACTION_SCHEMA_VERSION,
			pages: normalizedPages,
		});
		let document = {
			attachmentID: attachment?.id ?? attachment?.attachmentID ?? null,
			libraryID: attachment?.libraryID ?? null,
			attachmentKey: attachment?.key ?? attachment?.attachmentKey ?? null,
			parentItemID: attachment?.parentID ?? attachment?.parentItemID ?? null,
			title: normalizeText(options.title || attachment?.title || attachment?.getField?.("title") || ""),
			collectionPaths: Array.isArray(options.collectionPaths)
				? options.collectionPaths.slice()
				: Array.isArray(attachment?.collectionPaths) ? attachment.collectionPaths.slice() : [],
			fingerprint,
			sourceFingerprint: fingerprint,
			extractionSchemaVersion: options.extractionSchemaVersion || EXTRACTION_SCHEMA_VERSION,
			extractionMethod: options.method || "unknown",
			pages: normalizedPages,
			charCount: normalizedPages.reduce((count, page) => count + page.charCount, 0),
			pageCount: normalizedPages.length,
			extractionWarnings: dedupeWarnings(warnings),
		};
		return document;
	}

	function dedupeWarnings(warnings) {
		let seen = new Set();
		return warnings.filter(value => {
			let code = isObject(value) ? value.code : asString(value);
			if (seen.has(code)) {
				return false;
			}
			seen.add(code);
			return true;
		}).map(value => isObject(value) ? value : warning(value));
	}

	function getAttachmentID(attachment) {
		return attachment?.id ?? attachment?.attachmentID ?? attachment?.itemID;
	}

	function getExplicitExtractor(options, name) {
		let aliases = {
			structured: ["structuredExtractor", "structuredDocumentExtractor"],
			indexed: ["indexedExtractor", "indexedCacheExtractor", "indexedFullTextExtractor", "fullTextExtractor"],
			worker: ["workerExtractor", "pdfWorkerExtractor"],
		}[name] || [`${name}Extractor`];
		for (let alias of aliases) {
			let extractor = options?.[alias];
			if (typeof extractor === "function") {
				return extractor;
			}
		}
		let extractor = options?.[name];
		if (typeof extractor === "function") return extractor;
		extractor = options?.extractors?.[name]
			|| options?.extractors?.[aliases[0]];
		if (typeof extractor === "function") {
			return extractor;
		}
		extractor = options?.capabilities?.[name];
		return typeof extractor === "function" ? extractor : null;
	}

	async function readStructuredReader(reader) {
		if (!reader) {
			return null;
		}
		if (Array.isArray(reader.pages)) {
			return { pages: reader.pages };
		}
		if (typeof reader.getPages === "function") {
			let pages = await reader.getPages();
			if (Array.isArray(pages)) {
				return { pages };
			}
		}
		if (reader.document && Array.isArray(reader.document.pages)) {
			return { pages: reader.document.pages };
		}
		let count = typeof reader.getPageCount === "function"
			? await reader.getPageCount()
			: (Number.isInteger(reader.pageCount) ? reader.pageCount : 0);
		let pageGetter = typeof reader.getPage === "function" ? reader.getPage.bind(reader) : null;
		if (!pageGetter && typeof reader.getPageText === "function") {
			pageGetter = async index => ({ text: await reader.getPageText(index), pageNumber: index + 1 });
		}
		if (!count || !pageGetter) {
			if (typeof reader.getText === "function") return { text: await reader.getText() };
			if (typeof reader.text === "string") return { text: reader.text };
			return null;
		}
		let pages = [];
		for (let index = 0; index < count; index++) {
			let page = await pageGetter(index);
			if (typeof page === "string") {
				pages.push({ text: page, pageNumber: index + 1 });
				continue;
			}
			if (page && typeof page.getText === "function") {
				page = Object.assign({}, page, { text: await page.getText() });
			}
			pages.push(page || { text: "", pageNumber: index + 1 });
		}
		return { pages };
	}

	function builtInExtractor(zotero, attachment, name, options) {
		let id = getAttachmentID(attachment);
		if (name === "structured") {
			if (zotero?.SDT && typeof zotero.SDT.getReader === "function") {
				return async () => readStructuredReader(await zotero.SDT.getReader(id, {
					isPriority: options.isPriority !== false,
					onProgress: options.onProgress,
				}));
			}
			if (zotero?.PDFWorker && typeof zotero.PDFWorker.getStructuredDocumentText === "function") {
				return async () => {
					let result = await zotero.PDFWorker.getStructuredDocumentText(id, {
						isPriority: options.isPriority !== false,
						password: options.password,
						onProgress: options.onProgress,
					});
					// The worker's binary pack is intentionally not uploaded or
					// guessed at here. A caller can provide a supported pack parser.
					if (typeof options.structuredParser === "function") {
						return options.structuredParser(result, { attachment, signal: options.signal });
					}
					if (result?.pages || result?.text || result?.pageTexts) {
						return result;
					}
					return null;
				};
			}
		}
		if (name === "indexed") {
			let fulltext = zotero?.Fulltext || zotero?.FullText;
			if (fulltext && typeof fulltext.isFullyIndexed === "function"
				&& typeof fulltext.getItemCacheFile === "function") {
				return async () => {
					if (!(await fulltext.isFullyIndexed(attachment))) return null;
					let cacheFile = fulltext.getItemCacheFile(attachment);
					let path = cacheFile?.path || cacheFile;
					if (!path) return null;
					if (zotero?.File && typeof zotero.File.getContentsAsync === "function") {
						return { text: await zotero.File.getContentsAsync(path), indexed: true };
					}
					if (global.IOUtils && typeof global.IOUtils.readUTF8 === "function") {
						return { text: await global.IOUtils.readUTF8(path), indexed: true };
					}
					return null;
				};
			}
			if (fulltext && typeof fulltext.getText === "function") {
				return async () => fulltext.getText(attachment);
			}
		}
		if (name === "worker" && zotero?.PDFWorker && typeof zotero.PDFWorker.getFullText === "function") {
			return async () => zotero.PDFWorker.getFullText(id, null, options.isPriority !== false, options.password);
		}
		return null;
	}

	function detectCapabilities(options = {}) {
		let zotero = options.zotero || global.Zotero || {};
		let attachment = options.attachment;
		let result = {};
		for (let name of ["structured", "indexed", "worker"]) {
			let extractor = getExplicitExtractor(options, name) || builtInExtractor(zotero, attachment, name, options);
			result[name] = {
				name,
				available: typeof extractor === "function",
				extractor,
				priority: name === "structured" ? 1 : name === "indexed" ? 2 : 3,
			};
		}
		result.ordered = [result.structured, result.indexed, result.worker];
		result.structuredDocument = result.structured;
		result.indexedFullText = result.indexed;
		result.pdfWorker = result.worker;
		result.preferred = result.ordered.find(capability => capability.available)?.name || null;
		result.any = Boolean(result.preferred);
		result.pdf = isPDFAttachment(attachment);
		if (!result.pdf && attachment) {
			result.warning = warning("unsupported-attachment-type");
		}
		return result;
	}

	function isPDFAttachment(attachment) {
		if (!attachment) {
			return true;
		}
		if (typeof attachment.isFileAttachment === "function" && !attachment.isFileAttachment()) {
			return false;
		}
		if (typeof attachment.isPDFAttachment === "function") {
			return Boolean(attachment.isPDFAttachment());
		}
		return attachment.attachmentContentType === undefined
			|| attachment.attachmentContentType === "application/pdf"
			|| /\.pdf$/i.test(asString(attachment.filename || attachment.path));
	}

	function safeFailureCode(error) {
		if (!error) {
			return "unknown";
		}
		let name = asString(error.name).toLowerCase();
		if (name.includes("password") || name.includes("encrypted")) {
			return "password-required";
		}
		if (name.includes("abort") || name.includes("cancel")) {
			return "cancelled";
		}
		if (name.includes("notfound") || name.includes("missing")) {
			return "file-missing";
		}
		return "failed";
	}

	async function resolveAttachmentHash(attachment, options) {
		if (options.attachmentHash) {
			return asString(options.attachmentHash);
		}
		if (typeof attachment?.getAttachmentHash === "function") {
			return asString(await attachment.getAttachmentHash());
		}
		let value = attachment?.attachmentHash ?? attachment?.sourceHash;
		return asString(await value);
	}

	function checkCancelled(signal) {
		if (signal?.aborted) {
			let error = new Error("Extraction cancelled");
			error.name = "AbortError";
			throw error;
		}
	}

	async function extractDocument(attachment, options = {}) {
		if (!isPDFAttachment(attachment)) {
			return normalizeExtractionResult(attachment, null, {
				method: "none",
				warnings: [warning("unsupported-attachment-type")],
			});
		}
		let capabilities = options.detectedCapabilities || detectCapabilities({
			...options,
			attachment,
		});
		let warnings = [];
		let attachmentHash = await resolveAttachmentHash(attachment, options);
		for (let capability of capabilities.ordered) {
			if (!capability.available || typeof capability.extractor !== "function") {
				continue;
			}
			checkCancelled(options.signal);
			if (typeof options.onProgress === "function") {
				options.onProgress({ stage: "extracting", capability: capability.name });
			}
			try {
				let result = await capability.extractor({
					attachment,
					id: getAttachmentID(attachment),
					signal: options.signal,
					password: options.password,
					onProgress: options.onProgress,
				});
				checkCancelled(options.signal);
				let document = normalizeExtractionResult(attachment, result, {
					method: capability.name,
					warnings,
					attachmentHash,
					title: options.title,
					collectionPaths: options.collectionPaths,
					extractionSchemaVersion: options.extractionSchemaVersion,
				});
				if (document.charCount > 0) {
					return document;
				}
				warnings = document.extractionWarnings.concat(warning("empty-capability-result", capability.name));
			}
			catch (error) {
				let code = safeFailureCode(error);
				if (code === "cancelled") {
					throw error;
				}
				warnings.push(warning(code, capability.name));
			}
		}
		return normalizeExtractionResult(attachment, null, {
			method: "none",
			warnings: warnings.concat(warning("extraction-unavailable")),
			attachmentHash,
			title: options.title,
			collectionPaths: options.collectionPaths,
			extractionSchemaVersion: options.extractionSchemaVersion,
		});
	}

	const api = {
		EXTRACTION_SCHEMA_VERSION,
		SOURCE_ID_PATTERN,
		normalizeText,
		normalizePage,
		normalizeExtractionResult,
		makeSourceId,
		makeSourceID: makeSourceId,
		parseSourceId,
		stableHash,
		computeFingerprint,
		sourceFingerprint,
		fingerprint: sourceFingerprint,
		fingerprintSource: sourceFingerprint,
		isPDFAttachment,
		detectCapabilities,
		detectPDFCapabilities: detectCapabilities,
		extractDocument,
		extractPDF: extractDocument,
		extractSourceDocument: extractDocument,
		sourceIdForPage: makeSourceId,
		dedupeWarnings,
	};

	modules.extraction = api;
	modules.pdfExtraction = api;
})(globalThis);
