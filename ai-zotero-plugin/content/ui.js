/*
	AI for Zotero presentation and integration layer.

	The reader APIs hand this module a document and an append callback. All
	network-capable actions first render a local preview and only call the
	service after the user activates the localized confirmation button.
*/

"use strict";

(function () {
	let registry = globalThis.__AIZoteroModules || (globalThis.__AIZoteroModules = Object.create(null));
	let state = {
		pluginID: "ai-zotero@shayprasad",
		rootURI: "",
		service: null,
		api: null,
		unsubscribe: null,
	};
	let paneBodies = new Map();
	let documents = new Set();
	let injectedNodes = new Set();
	let activeOperations = new Map();
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const WARNING_L10N_IDS = new Map([
		["ai-zotero-warning-preview-unavailable", "ai-zotero-warning-preview-unavailable"],
		["ai-zotero-warning-state-unavailable", "ai-zotero-warning-state-unavailable"],
		["ai-zotero-warning-extraction-unavailable", "ai-zotero-warning-extraction-unavailable"],
		["ai-zotero-warning-cross-check-limit", "ai-zotero-warning-cross-check-limit"],
		["extraction-unavailable", "ai-zotero-warning-extraction-unavailable"],
		["page-boundaries-unavailable", "ai-zotero-warning-page-boundaries-unavailable"],
		["no-extracted-text", "ai-zotero-warning-no-extracted-text"],
		["file-missing", "ai-zotero-warning-file-missing"],
		["file-inaccessible", "ai-zotero-warning-file-inaccessible"],
		["unsupported-attachment-type", "ai-zotero-warning-unsupported-attachment"],
		["collection-cycle-or-duplicate", "ai-zotero-warning-collection-duplicate"],
		["dossier-failed", "ai-zotero-warning-dossier-failed"],
	]);

	const UI_CSS = `
		.ai-zotero-dialog,
		.ai-zotero-pane {
			box-sizing: border-box;
			color: inherit;
			font: inherit;
			max-width: min(42rem, calc(100vw - 2rem));
		}
		.ai-zotero-dialog {
			background: Canvas;
			border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
			border-radius: .45rem;
			box-shadow: 0 .35rem 1.25rem color-mix(in srgb, currentColor 22%, transparent);
			padding: 1rem;
			position: fixed;
			inset-block-start: 3.5rem;
			inset-inline-end: 1rem;
			z-index: 2147483646;
		}
		.ai-zotero-dialog h2,
		.ai-zotero-dialog h3,
		.ai-zotero-pane h3 {
			margin-block: 0 .65rem;
		}
		.ai-zotero-dialog p {
			margin-block: .55rem;
		}
		.ai-zotero-meta {
			display: grid;
			grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
			gap: .35rem .75rem;
			margin-block: .7rem;
		}
		.ai-zotero-meta dt {
			font-weight: 600;
		}
		.ai-zotero-meta dd {
			margin: 0;
			overflow-wrap: anywhere;
		}
		.ai-zotero-request-options {
			border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
			margin-block: .8rem;
			padding: .65rem;
		}
		.ai-zotero-request-options legend {
			font-weight: 600;
			padding-inline: .25rem;
		}
		.ai-zotero-request-options label {
			align-items: center;
			display: grid;
			gap: .4rem;
			grid-template-columns: minmax(8rem, max-content) minmax(10rem, 1fr);
			margin-block: .4rem;
		}
		.ai-zotero-request-options input,
		.ai-zotero-request-options select {
			box-sizing: border-box;
			max-inline-size: 100%;
			min-block-size: 2rem;
			min-inline-size: 0;
		}
		.ai-zotero-quote,
		.ai-zotero-output {
			border-inline-start: .2rem solid currentColor;
			margin-block: .75rem;
			padding: .5rem .75rem;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
		}
		.ai-zotero-quote {
			max-height: 12rem;
			overflow: auto;
			opacity: .88;
		}
		.ai-zotero-output {
			max-height: 24rem;
			overflow: auto;
		}
		.ai-zotero-warnings {
			margin-block: .7rem;
			padding-inline-start: 1.4rem;
		}
		.ai-zotero-actions {
			display: flex;
			flex-wrap: wrap;
			gap: .45rem;
			margin-block-start: .85rem;
		}
		.ai-zotero-actions > button,
		.ai-zotero-pane button {
			min-block-size: 2rem;
			padding-inline: .7rem;
		}
		.ai-zotero-cancel {
			margin-inline-start: auto;
		}
		.ai-zotero-progress {
			align-items: center;
			display: flex;
			gap: .5rem;
			margin-block: .7rem;
		}
		.ai-zotero-progress-bar {
			accent-color: currentColor;
			flex: 1;
			min-inline-size: 7rem;
		}
		.ai-zotero-file-list {
			margin-block: .6rem;
			max-block-size: 12rem;
			overflow: auto;
			padding-inline-start: 1.4rem;
		}
		.ai-zotero-file-list li {
			margin-block: .25rem;
			overflow-wrap: anywhere;
		}
		.ai-zotero-status {
			align-items: center;
			display: flex;
			gap: .4rem;
			margin-block-end: .65rem;
		}
		.ai-zotero-status-dot {
			border: .12rem solid currentColor;
			border-radius: 50%;
			display: inline-block;
			block-size: .55rem;
			inline-size: .55rem;
		}
		.ai-zotero-pane .ai-zotero-provenance {
			font-size: .9em;
			opacity: .8;
		}
		.ai-zotero-pane .ai-zotero-summary-preview {
			max-block-size: 16rem;
			overflow: auto;
			white-space: pre-wrap;
		}
		.ai-zotero-selection-actions {
			display: flex;
			flex-wrap: wrap;
			gap: .35rem;
		}
		.ai-zotero-icon {
			block-size: 1.15em;
			inline-size: 1.15em;
			object-fit: contain;
			vertical-align: text-bottom;
		}
		.ai-zotero-toolbar-button {
			align-items: center;
			display: inline-flex;
			justify-content: center;
			min-block-size: 2rem;
			min-inline-size: 2rem;
		}
		.ai-zotero-dialog :focus-visible,
		.ai-zotero-pane :focus-visible,
		.ai-zotero-toolbar-button:focus-visible {
			outline: .15rem solid currentColor;
			outline-offset: .15rem;
		}
		@media (prefers-reduced-motion: reduce) {
			.ai-zotero-dialog *,
			.ai-zotero-pane *,
			.ai-zotero-toolbar-button {
				animation-duration: 0.001ms !important;
				scroll-behavior: auto !important;
				transition-duration: 0.001ms !important;
			}
		}
		@media (max-width: 34rem) {
			.ai-zotero-dialog {
				inset-inline: .5rem;
				max-width: none;
			}
			.ai-zotero-meta {
				grid-template-columns: 1fr;
			}
		}
	`;

	function htmlElement(doc, tag) {
		try {
			return doc.createElementNS(HTML_NS, tag);
		}
		catch (e) {
			return doc.createElement(tag);
		}
	}

	function setL10n(element, id, args) {
		if (!element || !id) return element;
		element.setAttribute("data-l10n-id", id);
		if (args && Object.keys(args).length) {
			element.setAttribute("data-l10n-args", JSON.stringify(args));
		}
		try {
			element.ownerDocument?.l10n?.setAttributes?.(element, id, args || {});
		}
		catch (e) {
			// Fluent will translate the node when the document is ready.
		}
		return element;
	}

	function ensureLocalization(doc) {
		if (!doc?.querySelector || !doc?.createElementNS) return;
		if (doc.querySelector('link[rel="localization"][href="ai-zotero.ftl"]')) return;
		let link = htmlElement(doc, "link");
		link.setAttribute("rel", "localization");
		link.setAttribute("href", "ai-zotero.ftl");
		(doc.head || doc.documentElement)?.append(link);
	}

	function ensureStyles(doc) {
		if (!doc?.querySelector || !doc?.createElement) return;
		ensureLocalization(doc);
		if (doc.querySelector("style[data-ai-zotero-ui-style]")) return;
		let style = htmlElement(doc, "style");
		style.setAttribute("data-ai-zotero-ui-style", "true");
		style.textContent = UI_CSS;
		(doc.head || doc.documentElement)?.append(style);
		injectedNodes.add(style);
		documents.add(doc);
	}

	function iconURI(name, size) {
		return `${state.rootURI}icons/${name}-${size}.svg`;
	}

	function appendIcon(doc, parent, name, size) {
		let icon = htmlElement(doc, "img");
		icon.className = "ai-zotero-icon";
		icon.setAttribute("src", iconURI(name, size));
		icon.setAttribute("alt", "");
		icon.setAttribute("aria-hidden", "true");
		parent.append(icon);
		return icon;
	}

	function makeButton(doc, l10nID, callback, options = {}) {
		let button = htmlElement(doc, "button");
		button.setAttribute("type", "button");
		button.className = options.className || "";
		setL10n(button, l10nID, options.args);
		if (options.id) button.id = options.id;
		if (options.titleL10nID) setL10n(button, options.titleL10nID, options.titleArgs);
		if (options.disabled) button.disabled = true;
		if (options.icon) {
			appendIcon(doc, button, options.icon, options.iconSize || 20);
		}
		if (typeof callback === "function") {
			button.addEventListener("click", event => {
				event.preventDefault();
				callback(event, button);
			});
		}
		return button;
	}

	function setText(element, value) {
		if (element) element.textContent = value === undefined || value === null ? "" : String(value);
	}

	function warningL10nID(value) {
		return WARNING_L10N_IDS.get(String(value || "")) || "ai-zotero-warning-generic";
	}

	function renderWarnings(doc, parent, warnings) {
		if (!parent) return;
		parent.replaceChildren();
		let values = Array.isArray(warnings) ? warnings.slice(0, 20) : [];
		parent.hidden = !values.length;
		for (let warning of values) {
			let item = htmlElement(doc, "li");
			setL10n(item, warningL10nID(warning));
			parent.append(item);
		}
	}

	function addMeta(doc, parent, labelID, value) {
		let label = htmlElement(doc, "dt");
		setL10n(label, labelID);
		let valueElement = htmlElement(doc, "dd");
		setText(valueElement, value);
		parent.append(label, valueElement);
		return valueElement;
	}

	function previewDisplayValue(preview, kind) {
		let files = Array.isArray(preview.files) ? preview.files : [];
		let chars = preview.charCount || files.reduce((sum, file) => sum + (file.charCount || 0), 0);
		let pages = preview.pageCount || files.reduce((sum, file) => sum + (file.pageCount || 0), 0);
		return {
			provider: `${preview.providerName || preview.provider || ""}${preview.model ? ` — ${preview.model}` : ""}`,
			files: files.length,
			pages: pages || "",
			characters: chars ? new Intl.NumberFormat().format(chars) : "",
			tokens: preview.estimatedInputTokens
				? new Intl.NumberFormat().format(preview.estimatedInputTokens)
				: "",
			requests: preview.estimatedRequests || "",
			kind,
		};
	}

	function renderFileList(doc, parent, preview) {
		let files = Array.isArray(preview.files) ? preview.files : [];
		if (!files.length) return;
		let heading = htmlElement(doc, "h3");
		setL10n(heading, "ai-zotero-preview-files-heading");
		parent.append(heading);
		let list = htmlElement(doc, "ul");
		list.className = "ai-zotero-file-list";
		for (let [index, file] of files.entries()) {
			let item = htmlElement(doc, "li");
			let title = String(file.title || "");
			let content = item;
			if (preview.kind === "crosscheck") {
				let label = htmlElement(doc, "label");
				let checkbox = htmlElement(doc, "input");
				checkbox.type = "checkbox";
				checkbox.checked = true;
				checkbox.setAttribute("data-ai-zotero-file-index", String(index));
				checkbox.setAttribute("aria-label", title);
				label.append(checkbox);
				content = label;
				item.append(label);
			}
			let titleElement = htmlElement(doc, "span");
			setText(titleElement, title);
			content.append(titleElement);
			if (file.collectionPath?.length) {
				let path = htmlElement(doc, "span");
				setText(path, ` (${file.collectionPath.join(" / ")})`);
				content.append(path);
			}
			if (file.pageCount || file.charCount) {
				let details = htmlElement(doc, "span");
				setL10n(details, "ai-zotero-file-details", {
					pages: file.pageCount || 0,
					characters: file.charCount || 0,
				});
				content.append(" — ", details);
			}
			list.append(item);
		}
		parent.append(list);
	}

	function renderPreviewDetails(doc, parent, preview, kind) {
		let values = previewDisplayValue(preview, kind);
		let meta = htmlElement(doc, "dl");
		meta.className = "ai-zotero-meta";
		addMeta(doc, meta, "ai-zotero-preview-provider", values.provider);
		if (preview.title) addMeta(doc, meta, "ai-zotero-preview-document", preview.title);
		if (values.files) addMeta(doc, meta, "ai-zotero-preview-files", values.files);
		if (values.pages) addMeta(doc, meta, "ai-zotero-preview-pages", values.pages);
		if (values.characters) addMeta(doc, meta, "ai-zotero-preview-characters", values.characters);
		if (values.tokens) addMeta(doc, meta, "ai-zotero-preview-input-size", values.tokens);
		if (values.requests) addMeta(doc, meta, "ai-zotero-preview-requests", values.requests);
		if (preview.existingSummaryUpdate) {
			let update = htmlElement(doc, "p");
			setL10n(update, "ai-zotero-preview-existing-summary");
			parent.append(update);
		}
		parent.append(meta);
		renderFileList(doc, parent, preview);
		if (preview.selectionText) {
			let heading = htmlElement(doc, "h3");
			setL10n(heading, "ai-zotero-preview-selection-heading");
			let quote = htmlElement(doc, "blockquote");
			quote.className = "ai-zotero-quote";
			setText(quote, preview.selectionText);
			parent.append(heading, quote);
			if (preview.pageLabel) addMeta(doc, meta, "ai-zotero-preview-page", preview.pageLabel);
		}
		let privacy = htmlElement(doc, "p");
		setL10n(privacy, preview.privacyNoticeKey || "ai-zotero-preview-privacy-notice");
		let retention = htmlElement(doc, "p");
		setL10n(retention, preview.retentionWarningKey || "ai-zotero-preview-retention-warning");
		parent.append(privacy, retention);
		if (Array.isArray(preview.warnings) && preview.warnings.length) {
			let heading = htmlElement(doc, "h3");
			setL10n(heading, "ai-zotero-preview-warnings-heading");
			let list = htmlElement(doc, "ul");
			list.className = "ai-zotero-warnings";
			for (let warning of preview.warnings) {
				let item = htmlElement(doc, "li");
				setL10n(item, warningL10nID(warning));
				list.append(item);
			}
			parent.append(heading, list);
		}
	}

	function requestField(doc, labelID, control) {
		let label = htmlElement(doc, "label");
		let labelText = htmlElement(doc, "span");
		setL10n(labelText, labelID);
		label.append(labelText, control);
		return label;
	}

	function renderRequestOptions(doc, preview, kind) {
		let fieldset = htmlElement(doc, "fieldset");
		fieldset.className = "ai-zotero-request-options";
		let legend = htmlElement(doc, "legend");
		setL10n(legend, "ai-zotero-request-options");
		fieldset.append(legend);

		let provider = htmlElement(doc, "select");
		for (let [value, l10nID] of [
			["mistral", "ai-zotero-provider-mistral"],
			["openrouter", "ai-zotero-provider-openrouter"],
			["agentrouter", "ai-zotero-provider-agentrouter"],
		]) {
			let option = htmlElement(doc, "option");
			option.value = value;
			setL10n(option, l10nID);
			provider.append(option);
		}
		provider.value = preview.provider || "mistral";
		fieldset.append(requestField(doc, "ai-zotero-request-provider", provider));

		let model = htmlElement(doc, "input");
		model.type = "text";
		model.maxLength = 300;
		model.value = preview.model || "";
		model.setAttribute("autocomplete", "off");
		setL10n(model, "ai-zotero-model");
		fieldset.append(requestField(doc, "ai-zotero-request-model", model));

		let detail = null;
		if (kind === "summary") {
			detail = htmlElement(doc, "select");
			for (let [value, l10nID] of [
				["brief", "ai-zotero-detail-brief"],
				["high-level", "ai-zotero-detail-high-level"],
				["detailed", "ai-zotero-detail-detailed"],
			]) {
				let option = htmlElement(doc, "option");
				option.value = value;
				setL10n(option, l10nID);
				detail.append(option);
			}
			detail.value = preview.detailLevel || "high-level";
			fieldset.append(requestField(doc, "ai-zotero-request-detail", detail));
		}
		return { root: fieldset, provider, model, detail };
	}

	function removeDialog(dialog) {
		if (!dialog) return;
		let operationID = dialog._aiOperationID;
		if (operationID) {
			state.api?.cancel?.(operationID);
			activeOperations.delete(operationID);
		}
		dialog.remove();
		injectedNodes.delete(dialog);
	}

	function closeDialogs(doc) {
		for (let node of [...injectedNodes]) {
			if (node?.ownerDocument === doc && node.classList?.contains("ai-zotero-dialog")) {
				removeDialog(node);
			}
		}
	}

	function dialogHost(doc, anchor) {
		let host = doc.body || doc.documentElement;
		if (anchor?.ownerDocument === doc && anchor.parentNode?.append) {
			// Item-pane dialogs remain near the pane in the same document, while
			// reader dialogs attach to the document body for reliable keyboard focus.
			host = doc.body || anchor.parentNode;
		}
		return host;
	}

	function makeDialog(doc, kind, preview, context, anchor) {
		ensureStyles(doc);
		closeDialogs(doc);
		let dialog = htmlElement(doc, "section");
		dialog.className = "ai-zotero-dialog";
		dialog.setAttribute("role", "dialog");
		dialog.setAttribute("aria-modal", "false");
		dialog.setAttribute("tabindex", "-1");
		dialog.dataset.aiZoteroKind = kind;
		let heading = htmlElement(doc, "h2");
		setL10n(heading, kind === "summary"
			? "ai-zotero-summary-preview-heading"
			: kind === "explanation"
				? "ai-zotero-explanation-preview-heading"
				: "ai-zotero-cross-check-preview-heading");
		dialog.append(heading);
		let content = htmlElement(doc, "div");
		content.className = "ai-zotero-dialog-content";
		renderPreviewDetails(doc, content, preview, kind);
		dialog.append(content);
		let requestOptions = renderRequestOptions(doc, preview, kind);
		dialog.append(requestOptions.root);
		let progress = htmlElement(doc, "div");
		progress.className = "ai-zotero-progress";
		progress.hidden = true;
		let progressLabel = htmlElement(doc, "span");
		setL10n(progressLabel, "ai-zotero-progress-working");
		let progressBar = htmlElement(doc, "progress");
		progressBar.className = "ai-zotero-progress-bar";
		progressBar.max = 100;
		progressBar.value = 0;
		progress.append(progressLabel, progressBar);
		dialog.append(progress);
		let output = htmlElement(doc, "div");
		output.className = "ai-zotero-output";
		output.hidden = true;
		output.setAttribute("aria-live", "polite");
		dialog.append(output);
		let error = htmlElement(doc, "p");
		error.className = "ai-zotero-error";
		error.hidden = true;
		dialog.append(error);
		let actions = htmlElement(doc, "div");
		actions.className = "ai-zotero-actions";
		let confirmID = kind === "summary"
			? "ai-zotero-confirm-summary"
			: kind === "explanation"
				? "ai-zotero-confirm-explanation"
				: "ai-zotero-confirm-cross-check";
		let confirm = makeButton(doc, confirmID, null, { className: "ai-zotero-confirm" });
		let cancel = makeButton(doc, "ai-zotero-cancel", () => removeDialog(dialog), {
			className: "ai-zotero-cancel",
		});
		actions.append(confirm, cancel);
		dialog.append(actions);
		dialog._aiData = {
			kind, preview, context, output, progress, progressLabel, progressBar, error,
			confirm, cancel, actions, requestOptions,
		};
		if (kind === "crosscheck") {
			let checkboxes = dialog.querySelectorAll?.("input[data-ai-zotero-file-index]") || [];
			let updateSelection = () => {
				let selectedFileIndexes = Array.from(checkboxes)
					.filter(checkbox => checkbox.checked)
					.map(checkbox => Number(checkbox.getAttribute("data-ai-zotero-file-index")))
					.filter(index => Number.isInteger(index));
				dialog._aiData.context = { ...dialog._aiData.context, selectedFileIndexes };
				confirm.disabled = !selectedFileIndexes.length;
			};
			for (let checkbox of checkboxes) checkbox.addEventListener("change", updateSelection);
			updateSelection();
		}
		confirm.addEventListener("click", () => startOperation(dialog));
		dialog.addEventListener("keydown", event => {
			if (event.key === "Escape") {
				event.preventDefault();
				removeDialog(dialog);
			}
		});
		dialogHost(doc, anchor)?.append(dialog);
		injectedNodes.add(dialog);
		try {
			confirm.focus();
		}
		catch (e) {
			dialog.focus();
		}
		return dialog;
	}

	function localizedError(error) {
		let code = error?.code || "operation-failed";
		let known = [
			"aborted", "authentication", "credits", "context-length", "malformed-response",
			"model-not-found", "moderation", "network", "offline", "rate-limit", "timeout",
			"tls", "module-unavailable", "preview-required", "preview-expired", "preview-mismatch",
			"confirmation-required", "operation-failed",
		];
		return known.includes(code) ? `ai-zotero-error-${code}` : "ai-zotero-error-operation-failed";
	}

	function setProgress(dialog, progress) {
		let data = dialog._aiData;
		if (!data) return;
		data.progress.hidden = false;
		let stage = String(progress?.stage || "");
		let stageIDs = new Set([
			"working", "extracting", "analysing", "analysing-chunks", "synthesising",
			"validating", "validating-citations", "saving", "saving-note",
		]);
		setL10n(data.progressLabel, stageIDs.has(stage)
			? `ai-zotero-progress-${stage}` : "ai-zotero-progress-working");
		if (Number.isFinite(progress?.percent)) {
			data.progressBar.value = Math.max(0, Math.min(100, progress.percent));
		}
	}

	function resultText(result) {
		if (typeof result === "string") return result;
		if (!result || typeof result !== "object") return "";
		for (let key of ["text", "summary", "answer", "content", "output"]) {
			if (typeof result[key] === "string") return result[key];
		}
		return "";
	}

	function renderResult(dialog, response) {
		let data = dialog._aiData;
		if (!data) return;
		data.progress.hidden = true;
		data.output.hidden = false;
		let text = resultText(response?.result);
		if (text) setText(data.output, text);
		if (response?.result?.citationsValidated === false) {
			let warning = htmlElement(dialog.ownerDocument, "p");
			setL10n(warning, "ai-zotero-citations-unverified");
			data.output.after(warning);
		}
		if (data.kind === "explanation") {
			addExplanationActions(dialog, text);
		}
		else if (data.kind === "summary") {
			let copy = makeButton(dialog.ownerDocument, "ai-zotero-copy-summary", () => copyText(text), {});
			let open = makeButton(dialog.ownerDocument, "ai-zotero-open-note", () => {
				let noteID = response?.result?.noteID;
				if (Number.isInteger(noteID)) state.api?.openNote?.(noteID);
			}, {});
			data.actions.prepend(copy, open);
			refreshAllPanes();
		}
		else {
			let copy = makeButton(dialog.ownerDocument, "ai-zotero-copy-result", () => copyText(text), {});
			data.actions.prepend(copy);
		}
	}

	function showError(dialog, error) {
		let data = dialog._aiData;
		if (!data) return;
		data.progress.hidden = true;
		data.error.hidden = false;
		setL10n(data.error, localizedError(error));
		data.confirm.disabled = false;
		data.cancel.disabled = false;
	}

	function startOperation(dialog) {
		let data = dialog._aiData;
		if (!data || dialog._aiOperationID) return;
		data.confirm.disabled = true;
		data.cancel.disabled = false;
		setProgress(dialog, { stage: "extracting", percent: 0 });
		let method = data.kind === "summary"
			? state.api?.confirmSummary
			: data.kind === "explanation"
				? state.api?.confirmExplanation
				: state.api?.confirmCrossCheck;
		if (typeof method !== "function") {
			showError(dialog, { code: "module-unavailable" });
			return;
		}
		let options = {
			confirm: true,
			context: data.context,
			provider: data.requestOptions?.provider?.value,
			model: data.requestOptions?.model?.value,
			detailLevel: data.requestOptions?.detail?.value,
			onProgress: progress => setProgress(dialog, progress),
			onDelta: delta => {
				data.output.hidden = false;
				data.output.textContent += delta;
			},
		};
		let handle;
		try {
			handle = method.call(state.api, data.preview, options);
		}
		catch (error) {
			showError(dialog, error);
			return;
		}
		Promise.resolve(handle).then(operation => {
			if (!operation?.promise) {
				showError(dialog, operation?.error || { code: "operation-failed" });
				return null;
			}
			dialog._aiOperationID = operation.operationID;
			activeOperations.set(operation.operationID, dialog);
			return operation.promise.then(response => {
				activeOperations.delete(operation.operationID);
				dialog._aiOperationID = null;
				if (response?.ok) {
					renderResult(dialog, response);
				}
				else {
					showError(dialog, response?.error || { code: "operation-failed" });
				}
				return response;
			});
		}).catch(error => showError(dialog, error));
	}

	async function copyText(value) {
		let text = String(value || "");
		if (!text) return false;
		try {
			if (globalThis.navigator?.clipboard?.writeText) {
				await globalThis.navigator.clipboard.writeText(text);
				return true;
			}
		}
		catch (e) {
			// Try Zotero's privileged helper below.
		}
		try {
			Zotero.Utilities.Internal.copyTextToClipboard(text);
			return true;
		}
		catch (e) {
			return false;
		}
	}

	function readerItem(reader) {
		return reader?.item || reader?._item || reader?._internalReader?.item || null;
	}

	function isPDFReader(reader, params = {}) {
		if (params.preview || reader?.preview || reader?.constructor?.name === "ReaderPreview") return false;
		let item = readerItem(reader);
		try {
			if (item?.isPDFAttachment?.()) return true;
		}
		catch (e) {
			// Continue with reader type detection.
		}
		return [reader?.type, reader?._type, params.type].some(type => String(type || "").toLowerCase() === "pdf");
	}

	function selectionFromEvent(event) {
		let params = event?.params || {};
		let annotation = params.annotation || {};
		let text = params.selectionText || params.selectedText || params.text || annotation.text || "";
		let pageLabel = params.pageLabel || params.page || annotation.pageLabel || annotation.page || "";
		let pageIndex = Number.isInteger(params.pageIndex)
			? params.pageIndex
			: (Number.isInteger(annotation.pageIndex) ? annotation.pageIndex : null);
		return {
			text: String(text || ""),
			pageLabel: String(pageLabel || ""),
			pageIndex,
		};
	}

	function renderToolbar(event) {
		if (!event?.doc || !isPDFReader(event.reader, event.params)) return;
		let doc = event.doc;
		ensureStyles(doc);
		if (doc.querySelector?.('[data-ai-zotero-toolbar="summary"]')) return;
		let button = makeButton(doc, "ai-zotero-reader-summary", () => {
			showSummaryPreview(doc, {
				item: readerItem(event.reader),
				reader: event.reader,
				source: "reader-toolbar",
			}, button);
		}, {
			className: "ai-zotero-toolbar-button",
			icon: "ai-summary",
			iconSize: 24,
		});
		button.setAttribute("data-ai-zotero-toolbar", "summary");
		button.setAttribute("aria-haspopup", "dialog");
		injectedNodes.add(button);
		event.append(button);
	}

	function renderTextSelectionPopup(event) {
		if (!event?.doc || !isPDFReader(event.reader, event.params)) return;
		let selection = selectionFromEvent(event);
		if (!selection.text.trim()) return;
		let doc = event.doc;
		ensureStyles(doc);
		if (doc.querySelector?.('[data-ai-zotero-selection-action="explain"]')) return;
		let button = makeButton(doc, "ai-zotero-selection-explain", () => {
			showExplanationComposer(doc, {
				item: readerItem(event.reader),
				reader: event.reader,
				selectionText: selection.text,
				pageLabel: selection.pageLabel,
				pageIndex: selection.pageIndex,
				source: "selection-popup",
			}, button);
		}, {
			className: "ai-zotero-toolbar-button",
			icon: "ai-explain",
			iconSize: 20,
		});
		button.setAttribute("data-ai-zotero-selection-action", "explain");
		button.setAttribute("aria-haspopup", "dialog");
		injectedNodes.add(button);
		event.append(button);
	}

	function itemIsPDF(item) {
		try {
			return !!item?.isPDFAttachment?.();
		}
		catch (e) {
			return false;
		}
	}

	function collectionForItem(item) {
		if (!item) return null;
		let ids = [];
		try {
			ids = typeof item.getCollections === "function"
				? item.getCollections() : (Array.isArray(item.collections) ? item.collections : []);
		}
		catch (e) {
			ids = [];
		}
		for (let id of ids) {
			try {
				let collection = Zotero.Collections?.get?.(id);
				if (collection) return collection;
			}
			catch (e) {
				// Continue to the next collection ID.
			}
		}
		return null;
	}

	function renderItemPane(props) {
		let { body, item, doc } = props;
		if (!body) return;
		ensureStyles(doc || body.ownerDocument);
		body.replaceChildren();
		let root = htmlElement(body.ownerDocument, "div");
		root.className = "ai-zotero-pane";
		let status = htmlElement(body.ownerDocument, "div");
		status.className = "ai-zotero-status";
		let dot = htmlElement(body.ownerDocument, "span");
		dot.className = "ai-zotero-status-dot";
		let statusText = htmlElement(body.ownerDocument, "span");
		setL10n(statusText, "ai-zotero-status-not-generated");
		status.append(dot, statusText);
		root.append(status);
		let provenance = htmlElement(body.ownerDocument, "p");
		provenance.className = "ai-zotero-provenance";
		setL10n(provenance, "ai-zotero-provenance-empty");
		root.append(provenance);
		let summary = htmlElement(body.ownerDocument, "div");
		summary.className = "ai-zotero-summary-preview";
		root.append(summary);
		let warnings = htmlElement(body.ownerDocument, "ul");
		warnings.className = "ai-zotero-warnings";
		warnings.hidden = true;
		root.append(warnings);
		let actions = htmlElement(body.ownerDocument, "div");
		actions.className = "ai-zotero-actions";
		let generate = makeButton(body.ownerDocument, "ai-zotero-generate-summary", () => showSummaryPreview(body.ownerDocument, { item, source: "item-pane" }, root), {});
		let open = makeButton(body.ownerDocument, "ai-zotero-open-note", () => {
			let pane = paneBodies.get(body);
			if (Number.isInteger(pane?.summaryState?.noteID)) state.api?.openNote?.(pane.summaryState.noteID);
		}, {});
		let copy = makeButton(body.ownerDocument, "ai-zotero-copy-summary", () => copyText(paneBodies.get(body)?.summaryState?.text), {});
		let ask = makeButton(body.ownerDocument, "ai-zotero-ask-document", () => showExplanationComposer(body.ownerDocument, { item, source: "item-pane" }, root), {});
		let crossCheck = makeButton(body.ownerDocument, "ai-zotero-cross-check-collection", () => showCrossCheckPreview(body.ownerDocument, {
			item,
			collection: collectionForItem(item),
			source: "item-pane",
		}, root), {
			icon: "ai-compare",
			iconSize: 20,
		});
		actions.append(generate, open, copy, ask, crossCheck);
		root.append(actions);
		body.append(root);
		paneBodies.set(body, { body, root, item, doc: body.ownerDocument, statusText, provenance, summary, warnings, generate, open, copy, ask, crossCheck, summaryState: null });
		refreshItemPane(body, item);
	}

	async function refreshItemPane(body, item) {
		let pane = paneBodies.get(body);
		if (!pane || pane.item !== item) return;
		let summaryState;
		try {
			summaryState = await state.api?.getSummaryState?.({ item });
		}
		catch (e) {
			summaryState = { status: "error", warnings: [] };
		}
		pane = paneBodies.get(body);
		if (!pane || pane.item !== item) return;
		pane.summaryState = summaryState || { status: "not-generated" };
		let statusID = {
			"not-generated": "ai-zotero-status-not-generated",
			generating: "ai-zotero-status-generating",
			current: "ai-zotero-status-current",
			stale: "ai-zotero-status-stale",
			"source-missing": "ai-zotero-status-source-missing",
			error: "ai-zotero-status-error",
		}[summaryState?.status] || "ai-zotero-status-not-generated";
		setL10n(pane.statusText, statusID);
		let provenance = [];
		if (summaryState?.provider) provenance.push(summaryState.provider);
		if (summaryState?.model) provenance.push(summaryState.model);
		setText(pane.provenance, provenance.join(" — "));
		if (!provenance.length) setL10n(pane.provenance, "ai-zotero-provenance-empty");
		setText(pane.summary, summaryState?.text || "");
		pane.summary.hidden = !summaryState?.text;
		renderWarnings(pane.doc, pane.warnings, summaryState?.warnings);
		pane.open.disabled = !Number.isInteger(summaryState?.noteID);
		pane.copy.disabled = !summaryState?.text;
		pane.generate.disabled = summaryState?.status === "generating";
	}

	function refreshAllPanes() {
		for (let pane of paneBodies.values()) {
			refreshItemPane(pane.body, pane.item);
		}
	}

	async function showSummaryPreview(doc, context, anchor) {
		if (!state.api?.prepareSummary) return;
		let preview;
		try {
			preview = await state.api.prepareSummary(context);
		}
		catch (error) {
			return;
		}
		makeDialog(doc, "summary", preview, context, anchor);
	}

	function actionChoice(doc, id, value, callback) {
		let button = makeButton(doc, id, () => callback(value), {});
		button.dataset.aiZoteroQuestionMode = value;
		return button;
	}

	async function showExplanationPreview(doc, context, question, anchor) {
		if (!state.api?.prepareExplanation) return;
		let preview;
		try {
			preview = await state.api.prepareExplanation({ ...context, question });
		}
		catch (error) {
			return;
		}
		preview.question = String(question || "").slice(0, 2000);
		let dialog = makeDialog(doc, "explanation", preview, { ...context, question }, anchor);
		let questionElement = htmlElement(doc, "p");
		setText(questionElement, preview.question);
		questionElement.className = "ai-zotero-question";
		dialog.querySelector(".ai-zotero-dialog-content")?.prepend(questionElement);
		dialog._aiData.question = preview.question;
	}

	function showExplanationComposer(doc, context, anchor) {
		if (!context.selectionText && !context.item) return;
		ensureStyles(doc);
		closeDialogs(doc);
		let dialog = htmlElement(doc, "section");
		dialog.className = "ai-zotero-dialog";
		dialog.setAttribute("role", "dialog");
		dialog.setAttribute("aria-modal", "false");
		dialog.setAttribute("tabindex", "-1");
		let heading = htmlElement(doc, "h2");
		setL10n(heading, "ai-zotero-explain-heading");
		dialog.append(heading);
		if (context.selectionText) {
			let label = htmlElement(doc, "p");
			setL10n(label, "ai-zotero-selected-text-label");
			let quote = htmlElement(doc, "blockquote");
			quote.className = "ai-zotero-quote";
			setText(quote, context.selectionText);
			dialog.append(label, quote);
			if (context.pageLabel) {
				let page = htmlElement(doc, "p");
				setText(page, context.pageLabel);
				page.className = "ai-zotero-provenance";
				dialog.append(page);
			}
		}
		let choices = htmlElement(doc, "div");
		choices.className = "ai-zotero-selection-actions";
		let choose = question => {
			removeDialog(dialog);
			showExplanationPreview(doc, context, question, anchor);
		};
		choices.append(
			actionChoice(doc, "ai-zotero-explain-simply", "Explain simply", choose),
			actionChoice(doc, "ai-zotero-explain-context", "Explain in context", choose),
			actionChoice(doc, "ai-zotero-define-terms", "Define terms", choose),
			actionChoice(doc, "ai-zotero-critique-claim", "Critique this claim", choose)
		);
		dialog.append(choices);
		let custom = htmlElement(doc, "input");
		custom.type = "text";
		custom.className = "ai-zotero-custom-question";
		custom.maxLength = 2000;
		custom.setAttribute("autocomplete", "off");
		setL10n(custom, "ai-zotero-custom-question-placeholder");
		let customButton = makeButton(doc, "ai-zotero-custom-question-action", () => {
			if (custom.value.trim()) choose(custom.value.trim());
		}, {});
		dialog.append(custom, customButton);
		let actions = htmlElement(doc, "div");
		actions.className = "ai-zotero-actions";
		actions.append(makeButton(doc, "ai-zotero-cancel", () => removeDialog(dialog), { className: "ai-zotero-cancel" }));
		dialog.append(actions);
		dialog.addEventListener("keydown", event => {
			if (event.key === "Escape") {
				event.preventDefault();
				removeDialog(dialog);
			}
			if (event.key === "Enter" && event.target === custom) customButton.click();
		});
		dialogHost(doc, anchor)?.append(dialog);
		injectedNodes.add(dialog);
		custom.focus();
	}

	function addExplanationActions(dialog, answer) {
		let data = dialog._aiData;
		if (!data || data.explanationActionsAdded) return;
		data.explanationActionsAdded = true;
		let doc = dialog.ownerDocument;
		let copy = makeButton(doc, "ai-zotero-copy-answer", () => copyText(data.output.textContent), {});
		let save = makeButton(doc, "ai-zotero-save-to-summary", async () => {
			let result = await state.api?.saveExplanation?.({
				item: data.context?.item || null,
				quote: data.preview.selectionText,
				question: data.question || data.preview.question || "",
				answer: data.output.textContent || answer || "",
				pageLabel: data.preview.pageLabel,
				itemID: data.context?.itemID || data.context?.item?.id,
			});
			if (result?.ok) setL10n(save, "ai-zotero-saved-to-summary");
		}, {});
		data.actions.prepend(copy, save);
		let followup = htmlElement(doc, "input");
		followup.type = "text";
		followup.className = "ai-zotero-followup";
		followup.maxLength = 2000;
		followup.setAttribute("autocomplete", "off");
		setL10n(followup, "ai-zotero-follow-up-placeholder");
		let ask = makeButton(doc, "ai-zotero-follow-up", () => {
			if (!followup.value.trim()) return;
			let context = {
				...data.context,
				selectionText: data.preview.selectionText,
				pageLabel: data.preview.pageLabel,
				conversation: [
					...(data.context?.conversation || []),
					{ question: data.question || data.preview.question || "", answer: data.output.textContent || answer || "" },
				],
			};
			showExplanationPreview(doc, context, followup.value.trim(), dialog);
		}, {});
		data.actions.append(followup, ask);
	}

	async function showCrossCheckPreview(doc, context, anchor) {
		if (!state.api?.prepareCrossCheck) return;
		if (!context.collection) {
			context = { ...context, collection: collectionForItem(context.item) };
		}
		let preview;
		try {
			preview = await state.api.prepareCrossCheck(context);
		}
		catch (error) {
			return;
		}
		makeDialog(doc, "crosscheck", preview, context, anchor);
	}

	function getItemPaneRegistration(options) {
		return {
			paneID: "ai-zotero-pane",
			pluginID: options.pluginID,
			header: {
				l10nID: "ai-zotero-pane-header",
				icon: `${options.rootURI}icons/ai-summary-16.svg`,
			},
			sidenav: {
				l10nID: "ai-zotero-pane-sidenav",
				icon: `${options.rootURI}icons/ai-summary-20.svg`,
			},
			onItemChange: ({ item, setEnabled }) => setEnabled(itemIsPDF(item)),
			onRender: renderItemPane,
			onAsyncRender: async ({ body, item }) => refreshItemPane(body, item),
			onDestroy: ({ body }) => {
				for (let node of [...injectedNodes]) {
					if (node?.ownerDocument === body?.ownerDocument && node.classList?.contains("ai-zotero-dialog")) {
						removeDialog(node);
					}
				}
				paneBodies.delete(body);
			},
		};
	}

	function notify(event) {
		if (event?.type === "item" || event?.type === "file" || event?.type === "relation") {
			refreshAllPanes();
		}
	}

	function initialize(options = {}) {
		state.pluginID = options.pluginID || state.pluginID;
		state.rootURI = options.rootURI || state.rootURI;
		state.service = options.service || state.service;
		state.api = state.service?.getPublicAPI?.() || state.api;
		state.unsubscribe?.();
		state.unsubscribe = state.service?.subscribe?.(event => {
			if (event?.type === "notifier") notify(event);
		});
	}

	function shutdown() {
		for (let operationID of activeOperations.keys()) state.api?.cancel?.(operationID);
		activeOperations.clear();
		for (let node of [...injectedNodes]) {
			try {
				node.remove();
			}
			catch (e) {
				// A reader document may already have gone away.
			}
		}
		injectedNodes.clear();
		paneBodies.clear();
		documents.clear();
		state.unsubscribe?.();
		state.unsubscribe = null;
		state.api = null;
		state.service = null;
	}

	let ui = {
		initialize,
		shutdown,
		notify,
		renderToolbar,
		renderTextSelectionPopup,
		getItemPaneRegistration,
	};
	registry.ui = ui;
	registry.aiUI = ui;
})();
