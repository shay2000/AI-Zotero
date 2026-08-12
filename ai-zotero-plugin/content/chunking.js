(function (global) {
	"use strict";

	const modules = global.__AIZoteroModules || (global.__AIZoteroModules = {});

	const DEFAULT_CONTEXT_TOKENS = 8192;
	const SOURCE_SHARE = 0.70;
	const OUTPUT_SHARE = 0.15;
	const SAFETY_SHARE = 0.15;
	const OVERLAP_SHARE = 0.10;

	function asString(value) {
		return value === null || value === undefined ? "" : String(value);
	}

	function codePoints(text) {
		return Array.from(asString(text));
	}

	function isCombiningMark(value) {
		return /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F\uFE00-\uFE0F]/u.test(value);
	}

	function graphemes(text) {
		text = asString(text);
		if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
			try {
				let segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
				return Array.from(segmenter.segment(text), segment => segment.segment);
			}
			catch (e) {
				// Fall through to the small Unicode-aware fallback below.
			}
		}
		let result = [];
		for (let value of codePoints(text)) {
			let previous = result[result.length - 1] || "";
			if (isCombiningMark(value) || value === "\u200D" || previous.endsWith("\u200D")
				|| (/[\u{1F3FB}-\u{1F3FF}]/u.test(value) && previous)) {
				if (result.length) {
					result[result.length - 1] += value;
				}
				else {
					result.push(value);
				}
			}
			else {
				result.push(value);
			}
		}
		return result;
	}

	function isCJK(value) {
		return /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u.test(value);
	}

	/**
	 * Conservative, deterministic estimate. The baseline follows the plan's
	 * ceil(characters / 4) rule. CJK-heavy text receives an additional margin;
	 * callers can add a larger protocol margin for a particular provider.
	 */
	function estimateTokens(text, options = {}) {
		let values = codePoints(text);
		if (!values.length) {
			return 0;
		}
		let charsPerToken = Number(options.charsPerToken) > 0 ? Number(options.charsPerToken) : 4;
		let base = Math.ceil(values.length / charsPerToken);
		let cjkCount = values.filter(isCJK).length;
		let cjkRatio = cjkCount / values.length;
		let cjkMargin = Number.isFinite(options.cjkMargin) ? Number(options.cjkMargin) : 0.35;
		let safetyMargin = Number.isFinite(options.safetyMargin)
			? Number(options.safetyMargin) : 0;
		let factor = 1 + Math.max(0, safetyMargin) + cjkRatio * Math.max(0, cjkMargin);
		return Math.max(1, Math.ceil(base * factor));
	}

	function calculateBudgets(contextTokens = DEFAULT_CONTEXT_TOKENS, options = {}) {
		let context = Math.max(1, Math.floor(Number(contextTokens) || DEFAULT_CONTEXT_TOKENS));
		let sourceBudget = Math.max(1, Math.floor(context * SOURCE_SHARE));
		let outputBudget = Math.max(1, Math.floor(context * OUTPUT_SHARE));
		let safetyBudget = Math.max(1, context - sourceBudget - outputBudget);
		if (Number.isFinite(options.expectedOutputTokens)) {
			outputBudget = Math.min(outputBudget, Math.max(1, Math.floor(options.expectedOutputTokens)));
		}
		return {
			contextTokens: context,
			sourceBudget,
			outputBudget,
			safetyBudget,
			sourceShare: SOURCE_SHARE,
			outputShare: OUTPUT_SHARE,
			safetyShare: SAFETY_SHARE,
		};
	}

	function looksLikeHeading(text) {
		let value = asString(text).trim();
		if (!value || value.length > 180 || /[.!?。！？]$/.test(value)) {
			return false;
		}
		if (/^(abstract|introduction|background|methods?|results?|discussion|conclusion|references?)$/i.test(value)) {
			return true;
		}
		let words = value.split(/\s+/).filter(Boolean);
		let uppercaseWords = words.filter(word => /[A-ZÀ-ÖØ-Þ]/.test(word) && !/[a-zà-öø-ÿ]/.test(word));
		return words.length <= 12 && uppercaseWords.length >= Math.max(1, Math.ceil(words.length * 0.6));
	}

	function splitSentences(text) {
		text = asString(text).trim();
		if (!text) {
			return [];
		}
		if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
			try {
				let segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
				return Array.from(segmenter.segment(text), segment => segment.segment.trim()).filter(Boolean);
			}
			catch (e) {
				// Use the conservative punctuation fallback.
			}
		}
		return text.split(/(?<=[.!?。！？])\s+(?=[\p{L}\p{N}\[({"'])/u).map(value => value.trim()).filter(Boolean);
	}

	function splitSemanticUnits(page) {
		let text = asString(page?.text ?? page?.content ?? "").replace(/\r\n?/g, "\n").trim();
		if (!text) {
			return [];
		}
		let sourceId = page.sourceId || page.id || `S01-P${String(page.pageNumber || 1).padStart(3, "0")}`;
		let pageNumber = page.pageNumber || 1;
		let sectionNumber = page.sectionNumber || 1;
		let paragraphs = text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
		let units = [];
		let headingIndex = 0;
		for (let paragraph of paragraphs) {
			let lines = paragraph.split("\n").map(line => line.trim()).filter(Boolean);
			if (lines.length > 1 && looksLikeHeading(lines[0])) {
				let heading = lines.shift();
				units.push({
					text: heading,
					sourceIds: [sourceId],
					pageNumbers: [pageNumber],
					sectionKey: `${sectionNumber}:${headingIndex++}:${heading}`,
					heading: true,
					tokenEstimate: estimateTokens(heading),
				});
			}
			let body = lines.join(" ").trim();
			if (!body) {
				continue;
			}
			let sentenceUnits = splitSentences(body);
			if (!sentenceUnits.length) {
				sentenceUnits = [body];
			}
			let sectionKey = `${sectionNumber}:${headingIndex}`;
			for (let sentence of sentenceUnits) {
				units.push({
					text: sentence,
					sourceIds: [sourceId],
					pageNumbers: [pageNumber],
					sectionKey,
					heading: false,
					tokenEstimate: estimateTokens(sentence),
				});
			}
		}
		return units;
	}

	function mergeUnitMetadata(units) {
		let sourceIds = [];
		let pageNumbers = [];
		let sectionKeys = [];
		for (let unit of units) {
			for (let sourceId of unit.sourceIds || []) {
				if (!sourceIds.includes(sourceId)) {
					sourceIds.push(sourceId);
				}
			}
			for (let pageNumber of unit.pageNumbers || []) {
				if (!pageNumbers.includes(pageNumber)) {
					pageNumbers.push(pageNumber);
				}
			}
			if (unit.sectionKey && !sectionKeys.includes(unit.sectionKey)) {
				sectionKeys.push(unit.sectionKey);
			}
		}
		return { sourceIds, pageNumbers, sectionKeys };
	}

	function makeChunk(units, index, options = {}) {
		let metadata = mergeUnitMetadata(units);
		let text = units.map(unit => unit.text).filter(Boolean).join("\n\n").trim();
		return {
			chunkId: `C${String(index + 1).padStart(4, "0")}`,
			id: `C${String(index + 1).padStart(4, "0")}`,
			level: "evidence",
			text,
			tokenEstimate: estimateTokens(text),
			units: units.slice(),
			sourceIds: metadata.sourceIds,
			pageNumbers: metadata.pageNumbers,
			sectionKeys: metadata.sectionKeys,
			overlappedFrom: options.overlappedFrom || null,
		};
	}

	function splitOversizedUnit(unit, maxTokens) {
		let values = graphemes(unit.text);
		let result = [];
		let current = [];
		for (let value of values) {
			let candidate = current.join("") + value;
			if (current.length && estimateTokens(candidate) > maxTokens) {
				result.push(Object.assign({}, unit, {
					text: current.join(""),
					tokenEstimate: estimateTokens(current.join("")),
				}));
				current = [value];
			}
			else {
				current.push(value);
			}
		}
		if (current.length) {
			result.push(Object.assign({}, unit, {
				text: current.join(""),
				tokenEstimate: estimateTokens(current.join("")),
			}));
		}
		return result.length ? result : [unit];
	}

	function tailOverlapUnits(units, maxTokens, nextSectionKey) {
		let selected = [];
		let total = 0;
		for (let index = units.length - 1; index >= 0; index--) {
			let unit = units[index];
			if (unit.sectionKey !== nextSectionKey) {
				break;
			}
			let cost = unit.tokenEstimate || estimateTokens(unit.text);
			if (selected.length && total + cost > maxTokens) {
				break;
			}
			selected.unshift(unit);
			total += cost;
			if (total >= maxTokens) {
				break;
			}
		}
		return selected;
	}

	function packEvidenceUnits(units, maxTokens) {
		let expanded = [];
		for (let unit of units) {
			if (estimateTokens(unit.text) > maxTokens) {
				expanded.push(...splitOversizedUnit(unit, maxTokens));
			}
			else {
				expanded.push(unit);
			}
		}
		let chunks = [];
		let current = [];
		let currentTokens = 0;
		let currentOverlapFrom = null;
		for (let index = 0; index < expanded.length; index++) {
			let unit = expanded[index];
			let unitTokens = unit.tokenEstimate || estimateTokens(unit.text);
			if (!current.length) {
				current = [unit];
				currentTokens = unitTokens;
				continue;
			}
			if (currentTokens + unitTokens <= maxTokens) {
				current.push(unit);
				currentTokens += unitTokens;
				continue;
			}
			chunks.push(makeChunk(current, chunks.length, { overlappedFrom: currentOverlapFrom }));
			let overlapBudget = Math.max(1, Math.floor(maxTokens * OVERLAP_SHARE));
			let overlap = tailOverlapUnits(current, overlapBudget, unit.sectionKey);
			let previousChunk = chunks[chunks.length - 1];
			current = overlap.concat(unit);
			currentOverlapFrom = overlap.length ? previousChunk.chunkId : null;
			currentTokens = current.reduce((sum, value) => sum + (value.tokenEstimate || estimateTokens(value.text)), 0);
			// A single unit may be exactly at the limit; a repeated overlap must
			// never make a chunk exceed that limit.
			while (current.length > 1 && currentTokens > maxTokens) {
				current.shift();
				currentTokens = current.reduce((sum, value) => sum + (value.tokenEstimate || estimateTokens(value.text)), 0);
			}
			if (!overlap.some(value => current.includes(value))) {
				currentOverlapFrom = null;
			}
		}
		if (current.length) {
			chunks.push(makeChunk(current, chunks.length, { overlappedFrom: currentOverlapFrom }));
		}
		return chunks;
	}

	function groupChunks(chunks, maxTokens, level) {
		let groups = [];
		let current = [];
		let tokenEstimate = 0;
		for (let chunk of chunks) {
			let cost = chunk.tokenEstimate || estimateTokens(chunk.text || "");
			if (current.length && tokenEstimate + cost > maxTokens) {
				groups.push(makeGroup(current, groups.length, level));
				current = [];
				tokenEstimate = 0;
			}
			current.push(chunk);
			tokenEstimate += cost;
		}
		if (current.length) {
			groups.push(makeGroup(current, groups.length, level));
		}
		return groups;
	}

	function makeGroup(chunks, index, level) {
		let sourceIds = [];
		let pageNumbers = [];
		for (let chunk of chunks) {
			for (let sourceId of chunk.sourceIds || []) {
				if (!sourceIds.includes(sourceId)) sourceIds.push(sourceId);
			}
			for (let pageNumber of chunk.pageNumbers || []) {
				if (!pageNumbers.includes(pageNumber)) pageNumbers.push(pageNumber);
			}
		}
		return {
			groupId: `${level[0].toUpperCase()}${String(index + 1).padStart(4, "0")}`,
			id: `${level[0].toUpperCase()}${String(index + 1).padStart(4, "0")}`,
			level,
			chunkIds: chunks.map(chunk => chunk.chunkId || chunk.id),
			sourceIds,
			pageNumbers,
			inputTokenEstimate: chunks.reduce((sum, chunk) => sum + (chunk.tokenEstimate || 0), 0),
		};
	}

	function pagesFromDocument(document) {
		if (Array.isArray(document)) {
			return document;
		}
		if (Array.isArray(document?.pages)) {
			return document.pages;
		}
		if (document?.text !== undefined) {
			return String(document.text).split(/\f/).map((text, index) => ({
				text,
				pageNumber: index + 1,
				sourceId: `S01-P${String(index + 1).padStart(3, "0")}`,
			}));
		}
		return [];
	}

	function planHierarchicalChunks(document, options = {}) {
		let budgets = calculateBudgets(options.contextTokens || options.modelContextTokens || DEFAULT_CONTEXT_TOKENS, options);
		let maxChunkTokens = Math.max(1, Math.floor(options.maxChunkTokens || Math.min(
			budgets.sourceBudget,
			Math.max(64, Math.floor(budgets.sourceBudget * 0.5))
		)));
		let units = pagesFromDocument(document).flatMap(splitSemanticUnits);
		let leafChunks = packEvidenceUnits(units, maxChunkTokens);
		let consolidationBudget = Math.max(maxChunkTokens, Math.floor(budgets.sourceBudget * 0.8));
		let consolidationGroups = groupChunks(leafChunks, consolidationBudget, "section-consolidation");
		let synthesisInput = consolidationGroups.length
			? consolidationGroups.reduce((sum, group) => sum + group.inputTokenEstimate, 0)
			: 0;
		let plan = {
			budgets,
			maxChunkTokens,
			totalTokenEstimate: estimateTokens(pagesFromDocument(document).map(page => page.text || "").join("\n")),
			units,
			leafChunks,
			chunks: leafChunks,
			consolidationGroups,
			sectionChunks: consolidationGroups,
			synthesis: {
				level: "document-synthesis",
				groupIds: consolidationGroups.map(group => group.groupId),
				inputTokenEstimate: synthesisInput,
				outputBudget: budgets.outputBudget,
			},
			levels: [
				{ level: "evidence", chunks: leafChunks },
				{ level: "section-consolidation", groups: consolidationGroups },
				{ level: "document-synthesis", groups: consolidationGroups },
			],
		};
		return plan;
	}

	function hierarchicalChunk(document, options) {
		return planHierarchicalChunks(document, options);
	}

	const api = {
		DEFAULT_CONTEXT_TOKENS,
		SOURCE_SHARE,
		OUTPUT_SHARE,
		SAFETY_SHARE,
		OVERLAP_SHARE,
		graphemes,
		estimateTokens,
		estimateTokenCount: estimateTokens,
		calculateBudgets,
		splitSentences,
		splitSemanticUnits,
		planHierarchicalChunks,
		hierarchicalChunk,
		hierarchicalChunking: hierarchicalChunk,
		createChunkPlan: planHierarchicalChunks,
		buildChunkPlan: planHierarchicalChunks,
	};

	modules.chunking = api;
})(globalThis);
