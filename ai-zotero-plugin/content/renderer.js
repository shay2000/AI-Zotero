(function (global) {
	"use strict";

	const modules = global.__AIZoteroModules || (global.__AIZoteroModules = {});

	const ALLOWED_TYPES = new Set([
		"root", "text", "heading", "paragraph", "strong", "emphasis", "list", "listItem",
		"table", "tableRow", "tableCell", "link", "details", "summary",
	]);

	function asString(value) {
		return value === null || value === undefined ? "" : String(value);
	}

	function safeText(value) {
		let text = asString(value);
		try {
			text = text.normalize("NFC");
		}
		catch (e) {
			// Keep rendering available on runtimes without String#normalize.
		}
		return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
	}

	function escapeHTML(value) {
		return safeText(value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function text(value) {
		return { type: "text", value: safeText(value) };
	}

	function node(type, children = [], attrs = {}) {
		return { type, children: Array.isArray(children) ? children : [children], attrs };
	}

	function heading(level, children) {
		return node("heading", children, { level: Math.min(3, Math.max(1, Number(level) || 2)) });
	}

	function paragraph(children) {
		return node("paragraph", children);
	}

	function list(items, ordered = false) {
		return node("list", items, { ordered: Boolean(ordered) });
	}

	function link(children, href, label) {
		return node("link", children, { href, "aria-label": label || "" });
	}

	function isSafeZoteroHref(href) {
		return /^zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/[A-Za-z0-9%._~-]+\?page=\d+$/u.test(asString(href));
	}

	function buildSourceHref(citation, source) {
		let key = safeText(citation?.sourceKey || source?.attachmentKey || source?.sourceKey || source?.key);
		let libraryID = source?.libraryID ?? citation?.libraryID;
		let page = Number(citation?.page || citation?.pageNumber);
		if (!key || !Number.isInteger(page) || page < 1 || libraryID === undefined || libraryID === null) {
			return null;
		}
		let libraryPart = source?.libraryType === "group" || source?.isGroup
			? `groups/${encodeURIComponent(String(libraryID))}`
			: "library";
		let href = `zotero://open-pdf/${libraryPart}/items/${encodeURIComponent(key)}?page=${page}`;
		return isSafeZoteroHref(href) ? href : null;
	}

	function sourceForCitation(citation, sources) {
		let list = Array.isArray(sources) ? sources : sources ? [sources] : [];
		return list.find(source => {
			let key = source?.sourceKey || source?.attachmentKey || source?.key;
			return citation?.sourceKey ? key === citation.sourceKey : (source?.pages || []).some(page =>
				(page.sourceId || page.id) === citation?.sourceId);
		}) || null;
	}

	function citationNode(citation, sources) {
		let pageText = citation?.pageLabel || `p. ${citation?.page || citation?.pageNumber || "?"}`;
		let source = sourceForCitation(citation, sources);
		let href = buildSourceHref(citation, source);
		let content = `[${safeText(pageText)}]`;
		if (href) {
			return link([text(content)], href, `Open ${pageText} in Zotero`);
		}
		return text(content);
	}

	function citationsNode(citations, sources) {
		let values = Array.isArray(citations) ? citations : [];
		let children = [];
		values.forEach((citation, index) => {
			if (index) children.push(text(" "));
			children.push(citationNode(citation, sources));
		});
		return children;
	}

	function evidenceSection(title, entries, sources) {
		let values = Array.isArray(entries) ? entries : [];
		let children = [heading(2, [text(title)])];
		if (!values.length) {
			children.push(paragraph([text("No validated evidence was returned.")]));
			return children;
		}
		children.push(list(values.map(entry => node("listItem", [
			paragraph([
				text(entry.claim || ""),
				...(entry.citations?.length ? [text(" "), ...citationsNode(entry.citations, sources)] : []),
			]),
		]))));
		return children;
	}

	function detailsNode(metadata) {
		let values = metadata || {};
		let lines = [
			`Provider: ${safeText(values.provider || "Not recorded")}`,
			`Model: ${safeText(values.model || "Not recorded")}`,
			`Generated: ${safeText(values.createdAt || values.generatedAt || "Not recorded")}`,
			`Source fingerprint: ${safeText(values.sourceFingerprint || values.fingerprint || "Not recorded")}`,
		];
		return node("details", [
			node("summary", [text("Generation details")]),
			list(lines.map(line => node("listItem", [paragraph([text(line)])]))),
		]);
	}

	function renderSummaryAST(summary, options = {}) {
		let value = summary || {};
		let title = options.title || value.title || "AI Summary";
		let children = [heading(1, [text(title)])];
		children.push(heading(2, [text("Thesis")]), paragraph([text(value.thesis || "")]));
		children.push(heading(2, [text("Central question")]), paragraph([text(value.centralQuestion || "")]));
		children.push(...evidenceSection("Key findings", value.keyFindings, options.sources));
		children.push(...evidenceSection("Methods and evidence", value.methodsEvidence, options.sources));
		children.push(...evidenceSection("Limitations and uncertainties", value.limitationsUncertainties, options.sources));
		children.push(...evidenceSection("Important terminology", value.importantTerminology, options.sources));
		children.push(...evidenceSection("Implications and open questions", value.implicationsOpenQuestions, options.sources));
		if (value.citations?.length) {
			children.push(heading(2, [text("Evidence citations")]), paragraph(citationsNode(value.citations, options.sources)));
		}
		if (options.metadata) children.push(detailsNode(options.metadata));
		children.push(paragraph([node("emphasis", [text("AI-generated content may be inaccurate. Verify claims against the cited source pages.")])]));
		return node("root", children);
	}

	function renderCrosscheckAST(report, options = {}) {
		let value = report || {};
		let children = [heading(1, [text(options.title || "AI Cross-check")])];
		children.push(heading(2, [text("Executive synthesis")]), paragraph([text(value.executiveSynthesis || "")]));
		children.push(...evidenceSection("Recurring themes", value.recurringThemeMatrix, options.sources));
		children.push(...evidenceSection("Agreement areas", value.agreementAreas, options.sources));
		children.push(...evidenceSection("Contradictions and tensions", value.contradictionsTensions, options.sources));
		children.push(...evidenceSection("Methodological differences", value.methodologicalDifferences, options.sources));
		children.push(...evidenceSection("Unique contributions", value.uniqueContributions, options.sources));
		children.push(...evidenceSection("Gaps and unanswered questions", value.gapsUnansweredQuestions, options.sources));
		children.push(...evidenceSection("Source coverage and extraction warnings", value.sourceCoverageWarnings, options.sources));
		if (options.metadata) children.push(detailsNode(options.metadata));
		children.push(paragraph([node("emphasis", [text("AI-generated comparisons are evidence-bounded and may be inaccurate. Verify cited sources.")])]));
		return node("root", children);
	}

	function renderNode(value) {
		if (value === null || value === undefined) return "";
		if (typeof value === "string" || typeof value === "number") return escapeHTML(value);
		if (!ALLOWED_TYPES.has(value.type)) return "";
		if (value.type === "text") return escapeHTML(value.value);
		let children = (value.children || []).map(renderNode).join("");
		switch (value.type) {
			case "root": return children;
			case "heading": return `<h${value.attrs?.level || 2}>${children}</h${value.attrs?.level || 2}>`;
			case "paragraph": return `<p>${children}</p>`;
			case "strong": return `<strong>${children}</strong>`;
			case "emphasis": return `<em>${children}</em>`;
			case "list": return `<${value.attrs?.ordered ? "ol" : "ul"}>${children}</${value.attrs?.ordered ? "ol" : "ul"}>`;
			case "listItem": return `<li>${children}</li>`;
			case "table": return `<table><tbody>${children}</tbody></table>`;
			case "tableRow": return `<tr>${children}</tr>`;
			case "tableCell": return `<td>${children}</td>`;
			case "details": return `<details>${children}</details>`;
			case "summary": return `<summary>${children}</summary>`;
			case "link": {
				let href = isSafeZoteroHref(value.attrs?.href) ? value.attrs.href : null;
				if (!href) return children;
				let label = value.attrs?.["aria-label"] ? ` aria-label="${escapeHTML(value.attrs["aria-label"])}"` : "";
				return `<a href="${escapeHTML(href)}"${label}>${children}</a>`;
			}
			default: return "";
		}
	}

	function renderSafeHTML(ast) {
		return renderNode(ast);
	}

	function renderSummary(summary, options) {
		return renderSafeHTML(renderSummaryAST(summary, options));
	}

	function renderCrosscheck(report, options) {
		return renderSafeHTML(renderCrosscheckAST(report, options));
	}

	function renderPlainText(ast) {
		if (!ast) return "";
		if (ast.type === "text") return safeText(ast.value);
		return (ast.children || []).map(renderPlainText).join(ast.type === "paragraph" || ast.type === "listItem" ? "\n" : "");
	}

	const api = {
		ALLOWED_TYPES,
		escapeHTML,
		text,
		node,
		heading,
		paragraph,
		list,
		link,
		isSafeZoteroHref,
		buildSourceHref,
		citationNode,
		renderSummaryAST,
		renderCrosscheckAST,
		renderSafeHTML,
		renderSafeHtml: renderSafeHTML,
		renderAST: renderSafeHTML,
		renderHTML: renderSafeHTML,
		renderSummary,
		renderCrosscheck,
		renderPlainText,
	};

	modules.renderer = api;
})(globalThis);
