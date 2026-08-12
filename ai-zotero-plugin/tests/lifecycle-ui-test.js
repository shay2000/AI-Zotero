/*
	Focused lifecycle/UI contract test for the bootstrapped shell.

	This test uses a small VM harness so it can run without a Zotero profile or
	a provider. It verifies registration, explicit confirmation gating, safe API
	surface, and complete shutdown cleanup. No credentials or source text are
	used by the fixture.
*/

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness() {
	let registrations = {
		reader: new Map(),
		readerUnregistered: 0,
		pane: 0,
		paneUnregistered: 0,
		preference: 0,
		preferenceUnregistered: 0,
		notifier: 0,
		notifierUnregistered: 0,
	};
	let preferenceValues = new Map();
	let context;
	let rootPath = path.resolve(__dirname, "..");

	let Zotero = {
		Prefs: {
			get(key) {
				return preferenceValues.get(key);
			},
			set(key, value) {
				preferenceValues.set(key, value);
			},
		},
		Utilities: {
			randomString: length => "x".repeat(length),
			Internal: {
				openPreferences() {},
			},
		},
		Reader: {
			registerEventListener(type, handler) {
				registrations.reader.set(type, handler);
			},
			unregisterEventListener(type, handler) {
				if (registrations.reader.get(type) === handler) {
					registrations.reader.delete(type);
				}
				registrations.readerUnregistered++;
			},
		},
		ItemPaneManager: {
			registerSection() {
				registrations.pane++;
				return "ai-zotero-pane";
			},
			unregisterSection() {
				registrations.paneUnregistered++;
				return true;
			},
		},
		PreferencePanes: {
			async register() {
				registrations.preference++;
				return "ai-zotero-preferences";
			},
			unregister() {
				registrations.preferenceUnregistered++;
			},
		},
		Notifier: {
			registerObserver() {
				registrations.notifier++;
				return "ai-zotero-notifier";
			},
			unregisterObserver() {
				registrations.notifierUnregistered++;
			},
		},
		getString: id => id,
		debug() {},
	};

	context = {
		Zotero,
		console,
		Promise,
		Map,
		Set,
		Object,
		Array,
		String,
		Number,
		Boolean,
		Math,
		Date,
		Intl,
		URL,
		AbortController,
		setTimeout,
		clearTimeout,
	};
	context.globalThis = context;
	context.Services = {
		scriptloader: {
			loadSubScriptWithOptions(uri, options) {
				let relative = new URL(uri).pathname.split("/ai-zotero-plugin/")[1];
				let filePath = path.join(rootPath, relative);
				if (!fs.existsSync(filePath)) {
					throw Object.assign(new Error("missing optional module"), { code: "missing" });
				}
				let source = fs.readFileSync(filePath, "utf8");
				vm.runInContext(source, vmContext, { filename: filePath });
			},
		},
	};
	let vmContext = vm.createContext(context);
	return { context: vmContext, registrations };
}

async function runLifecycleUITests() {
	let harness = createHarness();
	let { context, registrations } = harness;
	let bootstrapPath = path.resolve(__dirname, "..", "bootstrap.js");
	vm.runInContext(fs.readFileSync(bootstrapPath, "utf8"), context, { filename: bootstrapPath });

	await context.startup({
		id: "ai-zotero@shayprasad",
		version: "0.1.0",
		rootURI: `${new URL("file:").href}${path.resolve(__dirname, "..").replace(/^\//, "")}/`,
	});

	assert.equal(registrations.reader.size, 2, "reader integrations register once");
	assert.equal(registrations.pane, 1, "AI item pane registers once");
	assert.equal(registrations.preference, 1, "AI preferences register once");
	assert.equal(registrations.notifier, 1, "notifier observer registers once");
	assert.ok(context.Zotero.AIZotero, "public namespace is created");
	assert.equal("apiKey" in context.Zotero.AIZotero.api, false, "public API has no API-key property");
	assert.equal("authorization" in context.Zotero.AIZotero.api, false, "public API has no authorization property");

	let networkCalls = 0;
	context.__AIZoteroModules.operations = {
		prepareSummary() {
			return { estimatedInputTokens: 12, estimatedRequests: 1 };
		},
		runSummary() {
			networkCalls++;
			return { text: "safe result" };
		},
	};
	let api = context.Zotero.AIZotero.api;
	let preview = await api.prepareSummary({ title: "Fixture", isPDF: true });
	let rejected = api.confirmSummary(preview, { confirm: false });
	let rejectedResult = await rejected.promise;
	assert.equal(rejectedResult.ok, false, "an unconfirmed preview is rejected");
	assert.equal(networkCalls, 0, "no provider call occurs before confirmation");

	let confirmedPreview = await api.prepareSummary({ title: "Fixture", isPDF: true });
	let operation = api.confirmSummary(confirmedPreview, { confirm: true });
	let result = await operation.promise;
	assert.equal(result.ok, true, "confirmed operation completes through the foundation module");
	assert.equal(networkCalls, 1, "confirmed operation calls the provider runner once");

	await context.shutdown({}, 2);
	assert.equal(context.Zotero.AIZotero, undefined, "public namespace is removed on shutdown");
	assert.equal(context.__AIZoteroModules, undefined, "private module registry is removed on shutdown");
	assert.equal(registrations.reader.size, 0, "reader listeners are removed");
	assert.equal(registrations.readerUnregistered, 2, "each reader listener is removed once");
	assert.equal(registrations.paneUnregistered, 1, "item pane is removed");
	assert.equal(registrations.preferenceUnregistered, 1, "preference pane is removed");
	assert.equal(registrations.notifierUnregistered, 1, "notifier observer is removed");

	let uiSource = fs.readFileSync(path.resolve(__dirname, "..", "content", "ui.js"), "utf8");
	let localeSource = fs.readFileSync(path.resolve(__dirname, "..", "locale", "en-US", "ai-zotero.ftl"), "utf8");
	assert.match(uiSource, /renderToolbar/);
	assert.match(uiSource, /renderTextSelectionPopup/);
	assert.match(uiSource, /prepareSummary/);
	assert.match(uiSource, /confirmSummary/);
	assert.match(localeSource, /ai-zotero-preview-privacy-notice/);
	assert.match(localeSource, /ai-zotero-confirm-and/);

	return registrations;
}

if (typeof module !== "undefined") {
	module.exports = { runLifecycleUITests };
}

if (require.main === module) {
	runLifecycleUITests()
		.then(() => process.stdout.write("AI Zotero lifecycle/UI tests passed\n"))
		.catch(error => {
			process.stderr.write(`${error.stack || error}\n`);
			process.exitCode = 1;
		});
}
