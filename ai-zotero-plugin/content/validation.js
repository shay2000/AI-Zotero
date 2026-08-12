(function (global) {
	"use strict";

	const modules = global.__AIZoteroModules || (global.__AIZoteroModules = {});
	const MAX_STRING_LENGTH = 200000;
	const MAX_ARRAY_LENGTH = 1000;

	function asString(value) {
		return value === null || value === undefined ? "" : String(value);
	}

	function safeText(value) {
		let text = asString(value);
		try {
			text = text.normalize("NFC");
		}
		catch (e) {
			// Keep the value usable on older runtimes.
		}
		return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
	}

	function error(code, path, message) {
		let result = { code, path: path || "" };
		if (message) {
			result.message = message;
		}
		return result;
	}

	function getField(object, names) {
		for (let name of names) {
			if (object && Object.prototype.hasOwnProperty.call(object, name)) {
				return object[name];
			}
		}
		return undefined;
	}

	function parseStructuredResponse(candidate) {
		if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
			if (candidate.value && typeof candidate.value === "object") {
				return { value: candidate.value, errors: [] };
			}
			if (candidate.json && typeof candidate.json === "object") {
				return { value: candidate.json, errors: [] };
			}
			if (typeof candidate.text === "string" && Object.keys(candidate).length <= 4) {
				return parseStructuredResponse(candidate.text);
			}
			return { value: candidate, errors: [] };
		}
		if (typeof candidate !== "string") {
			return { value: null, errors: [error("invalid-json", "", "Expected a JSON object")] };
		}
		let text = candidate.trim();
		if (text.startsWith("```") && text.endsWith("```")) {
			text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		}
		try {
			let value = JSON.parse(text);
			return { value, errors: [] };
		}
		catch (e) {
			return { value: null, errors: [error("invalid-json", "", "Response is not valid JSON")] };
		}
	}

	function makeCatalog(sources, knownSourceIds) {
		let entries = new Map();
		let sourceKeyMap = new Map();
		let list = Array.isArray(sources) ? sources : sources ? [sources] : [];
		for (let source of list) {
			if (!source) continue;
			let sourceKey = safeText(source.sourceKey || source.attachmentKey || source.key || source.id);
			if (sourceKey) {
				sourceKeyMap.set(sourceKey, source);
			}
			let pages = Array.isArray(source.pages) ? source.pages : [];
			let sourceIds = Array.isArray(source.sourceIds) ? source.sourceIds : [];
			let sourceEntryIds = new Set();
			for (let page of pages) {
				let sourceId = safeText(page?.sourceId || page?.id);
				if (!sourceId) continue;
				sourceEntryIds.add(sourceId);
				let entry = {
					sourceId,
					sourceKey,
					pageNumber: Number(page.pageNumber || page.page || 0) || null,
					pageLabel: safeText(page.label || page.pageLabel),
					page,
					source,
				};
				if (!entries.has(sourceId)) entries.set(sourceId, []);
				entries.get(sourceId).push(entry);
			}
			for (let sourceId of sourceIds) {
				sourceId = safeText(sourceId);
				if (!sourceId) continue;
				if (sourceEntryIds.has(sourceId)) continue;
				if (!entries.has(sourceId)) entries.set(sourceId, []);
				entries.get(sourceId).push({ sourceId, sourceKey, pageNumber: null, pageLabel: "", source });
			}
		}
		for (let sourceId of Array.isArray(knownSourceIds) ? knownSourceIds : []) {
			sourceId = safeText(sourceId);
			if (sourceId && !entries.has(sourceId)) {
				entries.set(sourceId, [{ sourceId, sourceKey: "", pageNumber: null, pageLabel: "", source: null }]);
			}
		}
		return { entries, sourceKeyMap };
	}

	function sourceIdPageNumber(sourceId) {
		let match = /-P(\d+)$/u.exec(asString(sourceId));
		return match ? Number(match[1]) : null;
	}

	function normalizeCitation(citation, catalog, path) {
		if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
			return { value: null, errors: [error("invalid-citation", path)] };
		}
		let sourceId = safeText(getField(citation, ["sourceId", "source_id", "id"]));
		let sourceKey = safeText(getField(citation, ["sourceKey", "source_key", "attachmentKey"]));
		let page = getField(citation, ["page", "pageNumber", "page_number"]);
		page = page === undefined || page === null || page === "" ? null : Number(page);
		let entries = catalog.entries.get(sourceId) || [];
		if (!sourceId || !entries.length) {
			return { value: null, errors: [error("unknown-source-id", `${path}.sourceId`)] };
		}
		if (entries.length > 1) {
			let matching = sourceKey ? entries.filter(entry => entry.sourceKey === sourceKey) : [];
			if (matching.length === 1) {
				entries = matching;
			}
			else {
				return { value: null, errors: [error("ambiguous-source-id", `${path}.sourceId`)] };
			}
		}
		let entry = entries[0];
		let errors = [];
		if (!Number.isInteger(page) || page < 1) {
			errors.push(error("invalid-page-reference", `${path}.page`));
		}
		let encodedPage = sourceIdPageNumber(sourceId);
		if (Number.isInteger(page) && encodedPage && page !== encodedPage) {
			errors.push(error("citation-page-mismatch", `${path}.page`));
		}
		if (Number.isInteger(page) && entry.pageNumber && page !== entry.pageNumber) {
			errors.push(error("citation-page-mismatch", `${path}.page`));
		}
		if (sourceKey && entry.sourceKey && sourceKey !== entry.sourceKey) {
			errors.push(error("citation-source-mismatch", `${path}.sourceKey`));
		}
		let normalized = {
			sourceId,
			page,
			sourceKey: sourceKey || entry.sourceKey || undefined,
			pageLabel: safeText(citation.pageLabel || citation.page_label || entry.pageLabel),
		};
		for (let field of ["locator", "quote"]) {
			if (citation[field] !== undefined) {
				if (typeof citation[field] !== "string" || citation[field].length > MAX_STRING_LENGTH) {
					errors.push(error("invalid-citation-text", `${path}.${field}`));
				}
				else {
					normalized[field] = safeText(citation[field]);
				}
			}
		}
		return { value: errors.length ? null : normalized, errors };
	}

	function validateCitations(citations, sources, options = {}, path = "citations") {
		let catalog = options.catalog || makeCatalog(sources, options.knownSourceIds);
		let errors = [];
		let values = [];
		if (!Array.isArray(citations) || citations.length > MAX_ARRAY_LENGTH) {
			return { values, errors: [error("invalid-citations", path)] };
		}
		for (let index = 0; index < citations.length; index++) {
			let result = normalizeCitation(citations[index], catalog, `${path}[${index}]`);
			errors.push(...result.errors);
			if (result.value) values.push(result.value);
		}
		return { values, errors };
	}

	function validateEvidenceEntry(value, path, catalog, options = {}) {
		let errors = [];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { value: null, errors: [error("invalid-evidence", path)] };
		}
		let claim = getField(value, ["claim", "statement", "text"]);
		if (typeof claim !== "string" || !claim.trim() || claim.length > MAX_STRING_LENGTH) {
			errors.push(error("invalid-evidence-claim", `${path}.claim`));
		}
		let citations = getField(value, ["citations", "evidenceCitations", "sources"]);
		let citationResult = validateCitations(citations, null, {
			catalog,
			knownSourceIds: options.knownSourceIds,
		}, `${path}.citations`);
		errors.push(...citationResult.errors);
		let result = {
			claim: safeText(claim),
			citations: citationResult.values,
		};
		if (value.label !== undefined) result.label = safeText(value.label);
		if (value.classification !== undefined) result.classification = safeText(value.classification);
		return { value: errors.length ? null : result, errors };
	}

	function validateString(value, path, errors, required = true) {
		if (value === undefined && !required) return "";
		if (typeof value !== "string" || value.length > MAX_STRING_LENGTH || (required && !value.trim())) {
			errors.push(error("invalid-string", path));
			return "";
		}
		return safeText(value);
	}

	function validateEvidenceArray(value, path, catalog, options, errors) {
		if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) {
			errors.push(error("invalid-evidence-array", path));
			return [];
		}
		let output = [];
		for (let index = 0; index < value.length; index++) {
			let result = validateEvidenceEntry(value[index], `${path}[${index}]`, catalog, options);
			errors.push(...result.errors);
			if (result.value) output.push(result.value);
		}
		return output;
	}

	function checkUnknownKeys(value, allowed, errors) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		for (let key of Object.keys(value)) {
			if (!allowed.includes(key)) {
				errors.push(error("unknown-field", key));
			}
		}
	}

	function validateSummary(candidate, sources, options = {}) {
		let parsed = parseStructuredResponse(candidate);
		if (parsed.errors.length) return { ok: false, value: null, errors: parsed.errors, warnings: [] };
		let value = parsed.value;
		let errors = [];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, value: null, errors: [error("invalid-summary", "")], warnings: [] };
		}
		let catalog = options.catalog || makeCatalog(sources, options.knownSourceIds);
		checkUnknownKeys(value, [
			"thesis", "centralThesis", "centralQuestion", "researchQuestion", "keyFindings", "findings",
			"methodsEvidence", "methods", "evidence", "limitationsUncertainties", "limitations", "uncertainties",
			"importantTerminology", "terminology", "implicationsOpenQuestions", "implications", "openQuestions", "citations",
		], errors);
		let output = {
			thesis: validateString(getField(value, ["thesis", "centralThesis"]), "thesis", errors),
			centralQuestion: validateString(getField(value, ["centralQuestion", "researchQuestion"]), "centralQuestion", errors),
		};
		output.keyFindings = validateEvidenceArray(getField(value, ["keyFindings", "findings"]), "keyFindings", catalog, options, errors);
		output.methodsEvidence = validateEvidenceArray(getField(value, ["methodsEvidence", "methods", "evidence"]), "methodsEvidence", catalog, options, errors);
		output.limitationsUncertainties = validateEvidenceArray(getField(value, ["limitationsUncertainties", "limitations", "uncertainties"]), "limitationsUncertainties", catalog, options, errors);
		output.importantTerminology = validateEvidenceArray(getField(value, ["importantTerminology", "terminology"]), "importantTerminology", catalog, options, errors);
		output.implicationsOpenQuestions = validateEvidenceArray(getField(value, ["implicationsOpenQuestions", "implications", "openQuestions"]), "implicationsOpenQuestions", catalog, options, errors);
		if (value.citations !== undefined) {
			let topLevel = validateCitations(value.citations, null, { catalog, knownSourceIds: options.knownSourceIds }, "citations");
			errors.push(...topLevel.errors);
			output.citations = topLevel.values;
		}
		else {
			output.citations = [];
		}
		return {
			ok: errors.length === 0,
			value: errors.length ? null : output,
			errors,
			warnings: [],
		};
	}

	function validateCrosscheck(candidate, sources, options = {}) {
		let parsed = parseStructuredResponse(candidate);
		if (parsed.errors.length) return { ok: false, value: null, errors: parsed.errors, warnings: [] };
		let value = parsed.value;
		let errors = [];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, value: null, errors: [error("invalid-crosscheck", "")], warnings: [] };
		}
		let catalog = options.catalog || makeCatalog(sources, options.knownSourceIds);
		let aliases = {
			executiveSynthesis: ["executiveSynthesis", "executiveSummary"],
			recurringThemeMatrix: ["recurringThemeMatrix", "recurringThemes", "themes"],
			agreementAreas: ["agreementAreas", "agreements"],
			contradictionsTensions: ["contradictionsTensions", "contradictions", "tensions"],
			methodologicalDifferences: ["methodologicalDifferences", "methodsDifferences"],
			uniqueContributions: ["uniqueContributions", "uniqueFindings"],
			gapsUnansweredQuestions: ["gapsUnansweredQuestions", "gaps", "unansweredQuestions"],
			sourceCoverageWarnings: ["sourceCoverageWarnings", "coverageWarnings"],
		};
		let allowed = Object.values(aliases).flat();
		checkUnknownKeys(value, allowed, errors);
		let output = {
			executiveSynthesis: validateString(getField(value, aliases.executiveSynthesis), "executiveSynthesis", errors),
		};
		for (let field of Object.keys(aliases).filter(field => field !== "executiveSynthesis")) {
			output[field] = validateEvidenceArray(getField(value, aliases[field]), field, catalog, options, errors);
		}
		return {
			ok: errors.length === 0,
			value: errors.length ? null : output,
			errors,
			warnings: [],
		};
	}

	function validateStructuredResult(candidate, options = {}) {
		let kind = options.kind || "summary";
		return kind === "crosscheck"
			? validateCrosscheck(candidate, options.sources, options)
			: validateSummary(candidate, options.sources, options);
	}

	function safePlainText(candidate, options = {}) {
		let parsed = parseStructuredResponse(candidate);
		let value = parsed.value;
		if (!value || typeof value !== "object") {
			return "The AI response could not be validated and was not saved.\n";
		}
		let lines = [];
		function add(label, field) {
			let item = value[field];
			if (typeof item === "string" && item.trim()) lines.push(`${label}: ${safeText(item)}`);
			else if (Array.isArray(item)) {
				for (let entry of item) {
					if (entry?.claim) lines.push(`- ${safeText(entry.claim)}`);
				}
			}
		}
		if (options.kind === "crosscheck") {
			add("Executive synthesis", "executiveSynthesis");
			for (let field of ["recurringThemeMatrix", "agreementAreas", "contradictionsTensions", "methodologicalDifferences", "uniqueContributions", "gapsUnansweredQuestions"]) add(field, field);
		}
		else {
			for (let field of ["thesis", "centralQuestion", "keyFindings", "methodsEvidence", "limitationsUncertainties", "importantTerminology", "implicationsOpenQuestions"]) add(field, field);
		}
		return lines.join("\n") || "The AI response could not be validated and was not saved.\n";
	}

	async function validateWithRepair(candidate, options = {}) {
		let initial = validateStructuredResult(candidate, options);
		if (initial.ok || options.repair === false) {
			return Object.assign({ repaired: false, manualReviewRequired: !initial.ok }, initial);
		}
		let promptModule = modules.prompts;
		let buildRepairPrompt = promptModule?.buildRepairPrompt;
		let repairFunction = typeof options.repair === "function"
			? options.repair
			: typeof options.repairProvider === "function" ? options.repairProvider : null;
		if (!repairFunction || typeof buildRepairPrompt !== "function") {
			return Object.assign({ repaired: false, manualReviewRequired: true }, initial);
		}
		let prompt = buildRepairPrompt({
			kind: options.kind || "summary",
			candidate,
			errors: initial.errors,
			sourceIds: options.knownSourceIds || collectKnownSourceIds(options.sources),
			responseSchema: options.responseSchema,
		});
		try {
			let repairedCandidate = await repairFunction({ prompt, candidate, errors: initial.errors });
			let repaired = validateStructuredResult(repairedCandidate, options);
			return Object.assign({ repaired: repaired.ok, manualReviewRequired: !repaired.ok, repairPrompt: prompt }, repaired);
		}
		catch (e) {
			return {
				ok: false,
				value: null,
				errors: initial.errors.concat(error("repair-failed", "")),
				warnings: [],
				repaired: false,
				manualReviewRequired: true,
				repairPrompt: prompt,
			};
		}
	}

	function collectKnownSourceIds(sources) {
		let ids = [];
		let list = Array.isArray(sources) ? sources : sources ? [sources] : [];
		for (let source of list) {
			for (let page of source?.pages || []) {
				let id = page.sourceId || page.id;
				if (id && !ids.includes(id)) ids.push(id);
			}
			for (let id of source?.sourceIds || []) if (id && !ids.includes(id)) ids.push(id);
		}
		return ids;
	}

	const api = {
		parseStructuredResponse,
		makeCatalog,
		collectKnownSourceIds,
		normalizeCitation,
		validateCitations,
		validateSummary,
		validateSummaryResult: validateSummary,
		validateCrosscheck,
		validateCrosscheckResult: validateCrosscheck,
		validateStructuredResult,
		validate: validateStructuredResult,
		validateWithRepair,
		repairResult: validateWithRepair,
		safePlainText,
	};

	modules.validation = api;
})(globalThis);
