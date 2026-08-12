/*
	AI for Zotero bootstrap entry point.

	This file deliberately keeps the plugin boundary small. Feature modules are
	loaded into the private __AIZoteroModules registry and only the redacted API
	returned by service.js is published as Zotero.AIZotero.
*/

"use strict";

const AI_ZOTERO_ID = "ai-zotero@shayprasad";
const AI_ZOTERO_PREFERENCE_PANE_ID = "ai-zotero-preferences";

// Load the small modules in dependency order. The service and UI modules are
// loaded last so that they can discover every foundational module through the
// private __AIZoteroModules registry.
const FOUNDATIONAL_MODULES = [
	"constants.js",
	"utils.js",
	"errors.js",
	"sse.js",
	"providers.js",
	"credentials.js",
	"settings.js",
	"extraction.js",
	"chunking.js",
	"prompts.js",
	"validation.js",
	"renderer.js",
	"notes.js",
	"crosscheck.js",
	"operations.js",
];

let aiZoteroRuntime = null;

function _safeErrorCode(error) {
	if (!error) {
		return "unknown";
	}
	if (typeof error === "object" && typeof error.code === "string") {
		return error.code.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
	}
	if (typeof error === "object" && typeof error.name === "string") {
		return error.name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
	}
	return "error";
}

function _debug(message, level = 3) {
	try {
		Zotero.debug(`[AI Zotero] ${message}`, level);
	}
	catch (e) {
		// Bootstrap must remain usable in a minimal test harness.
	}
}

function _rootURI(data) {
	let rootURI = typeof data === "string" ? data : data?.rootURI;
	if (!rootURI) {
		throw new Error("AI Zotero plugin root URI is missing");
	}
	return rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
}

function _moduleFiles(data) {
	let extra = Array.isArray(data?.moduleFiles)
		? data.moduleFiles.filter(file => typeof file === "string")
		: [];
	let files = [...extra, ...FOUNDATIONAL_MODULES, "service.js", "ui.js"];
	let seen = new Set();
	return files.filter(file => {
		let normalized = file.replace(/^content\//, "");
		if (!normalized.endsWith(".js") || seen.has(normalized)) {
			return false;
		}
		seen.add(normalized);
		return true;
	}).map(file => file.startsWith("content/") ? file : `content/${file}`);
}

function _loadModule(rootURI, relativePath, required) {
	let uri = `${rootURI}${relativePath}`;
	try {
		Services.scriptloader.loadSubScriptWithOptions(uri, {
			target: globalThis,
			ignoreCache: true,
		});
		return true;
	}
	catch (error) {
		if (required) {
			throw error;
		}
		// A staged checkout may not contain every foundational module yet. Do not
		// log the exception because provider errors can contain sensitive data.
		_debug(`Optional module unavailable (${relativePath})`, 4);
		return false;
	}
}

function _loadModules(data, rootURI) {
	globalThis.__AIZoteroModules = Object.create(null);
	let files = _moduleFiles(data);
	for (let relativePath of files) {
		_loadModule(rootURI, relativePath, true);
	}
	return globalThis.__AIZoteroModules;
}

function _module(registry, ...names) {
	for (let name of names) {
		if (registry?.[name]) {
			return registry[name];
		}
	}
	return null;
}

function _localizedLabel() {
	try {
		if (typeof Zotero.getString === "function") {
			return Zotero.getString("ai-zotero-preferences-label");
		}
	}
	catch (e) {
		// Fall through to the stable English label in a minimal harness.
	}
	return "AI for Zotero";
}

async function _registerIntegrations(runtime) {
	let { service, ui } = runtime;
	if (!service || !ui) {
		throw new Error("AI Zotero integration modules are unavailable");
	}

	if (typeof service.initialize === "function") {
		await service.initialize({
			pluginID: runtime.pluginID,
			version: runtime.version,
			rootURI: runtime.rootURI,
		});
	}
	if (typeof ui.initialize === "function") {
		ui.initialize({
			pluginID: runtime.pluginID,
			rootURI: runtime.rootURI,
			service,
		});
	}

	if (Zotero.Reader?.registerEventListener) {
		runtime.readerHandlers = {
			renderToolbar: event => ui.renderToolbar(event),
			renderTextSelectionPopup: event => ui.renderTextSelectionPopup(event),
		};
		for (let [type, handler] of Object.entries(runtime.readerHandlers)) {
			Zotero.Reader.registerEventListener(type, handler, runtime.pluginID);
		}
	}

	if (Zotero.ItemPaneManager?.registerSection && typeof ui.getItemPaneRegistration === "function") {
		let options = ui.getItemPaneRegistration({
			pluginID: runtime.pluginID,
			rootURI: runtime.rootURI,
		});
		runtime.itemPaneID = Zotero.ItemPaneManager.registerSection(options);
		if (!runtime.itemPaneID) {
			throw new Error("AI Zotero item pane registration failed");
		}
	}

	if (Zotero.PreferencePanes?.register) {
		runtime.preferencePaneID = await Zotero.PreferencePanes.register({
			id: AI_ZOTERO_PREFERENCE_PANE_ID,
			pluginID: runtime.pluginID,
			label: _localizedLabel(),
			image: `${runtime.rootURI}icons/ai-summary-20.svg`,
			src: `${runtime.rootURI}content/preferences.xhtml`,
			scripts: [`${runtime.rootURI}content/preferences.js`],
			stylesheets: [`${runtime.rootURI}content/preferences.css`],
			helpURL: "https://www.zotero.org/support/",
		});
	}
}

function _registerNotifier(runtime) {
	if (!Zotero.Notifier?.registerObserver) {
		return;
	}
	runtime.notifier = {
		notify(event, type, ids) {
			// IDs and event types are enough to refresh UI state. Deliberately do
			// not forward extraData, which can contain source or note content.
			runtime.service?.notify?.({ event, type, ids });
			runtime.ui?.notify?.({ event, type, ids });
		},
	};
	runtime.notifierID = Zotero.Notifier.registerObserver(
		runtime.notifier,
		["item", "collection", "file", "relation", "setting", "tab"],
		"ai-zotero"
	);
}

function _createNamespace(runtime) {
	let publicAPI = typeof runtime.service.getPublicAPI === "function"
		? runtime.service.getPublicAPI()
		: Object.freeze({});
	let namespace = {
		id: runtime.pluginID,
		version: runtime.version,
		api: publicAPI,
		openPreferences() {
			try {
				Zotero.Utilities.Internal.openPreferences(AI_ZOTERO_PREFERENCE_PANE_ID);
			}
			catch (e) {
				return false;
			}
			return true;
		},
		cancelAll() {
			return runtime.service.cancelAll?.() || 0;
		},
	};
	runtime.namespace = Object.freeze(namespace);
	Zotero.AIZotero = runtime.namespace;
}

function _registerRuntimeFactory(runtime) {
	if (typeof runtime.modules.Runtime === "function") {
		return;
	}
	// Foundation tests and future modules use this private factory. It returns
	// the same redacted facade as Zotero.AIZotero.api and never exposes the
	// module registry or Login Manager values.
	runtime.modules.Runtime = function Runtime() {
		return runtime.service?.getPublicAPI?.() || Object.freeze({});
	};
}

async function _shutdownRuntime(runtime) {
	if (!runtime || runtime.shuttingDown) {
		return;
	}
	runtime.shuttingDown = true;

	try {
		runtime.service?.cancelAll?.();
	}
	catch (e) {
		_debug(`Cancellation cleanup failed (${_safeErrorCode(e)})`, 2);
	}

	if (runtime.readerHandlers && Zotero.Reader?.unregisterEventListener) {
		for (let [type, handler] of Object.entries(runtime.readerHandlers)) {
			try {
				Zotero.Reader.unregisterEventListener(type, handler);
			}
			catch (e) {
				_debug(`Reader listener cleanup failed (${type})`, 2);
			}
		}
	}

	if (runtime.itemPaneID && Zotero.ItemPaneManager?.unregisterSection) {
		try {
			Zotero.ItemPaneManager.unregisterSection(runtime.itemPaneID);
		}
		catch (e) {
			_debug(`Item pane cleanup failed (${_safeErrorCode(e)})`, 2);
		}
	}

	if (runtime.preferencePaneID && Zotero.PreferencePanes?.unregister) {
		try {
			Zotero.PreferencePanes.unregister(runtime.preferencePaneID);
		}
		catch (e) {
			_debug(`Preference pane cleanup failed (${_safeErrorCode(e)})`, 2);
		}
	}

	if (runtime.notifierID && Zotero.Notifier?.unregisterObserver) {
		try {
			Zotero.Notifier.unregisterObserver(runtime.notifierID);
		}
		catch (e) {
			_debug(`Notifier cleanup failed (${_safeErrorCode(e)})`, 2);
		}
	}

	try {
		runtime.ui?.shutdown?.();
	}
	catch (e) {
		_debug(`UI cleanup failed (${_safeErrorCode(e)})`, 2);
	}
	try {
		await runtime.service?.shutdown?.();
	}
	catch (e) {
		_debug(`Service cleanup failed (${_safeErrorCode(e)})`, 2);
	}

	let registry = runtime.modules;
	if (registry) {
		let modules = Object.values(registry).filter((value, index, values) => {
			return value && value !== runtime.service && value !== runtime.ui && values.indexOf(value) === index;
		});
		for (let module of modules.reverse()) {
			try {
				await module.shutdown?.({ pluginID: runtime.pluginID });
				await module.unload?.({ pluginID: runtime.pluginID });
			}
			catch (e) {
				_debug(`Module cleanup failed (${_safeErrorCode(e)})`, 2);
			}
		}
	}

	if (Zotero.AIZotero === runtime.namespace) {
		delete Zotero.AIZotero;
	}
	if (globalThis.__AIZoteroRuntime === runtime) {
		delete globalThis.__AIZoteroRuntime;
	}
	delete globalThis.__AIZoteroModules;
	aiZoteroRuntime = null;
}

async function startup(data, reason) {
	if (aiZoteroRuntime) {
		await _shutdownRuntime(aiZoteroRuntime);
	}

	let rootURI = _rootURI(data);
	let runtime = {
		pluginID: data?.id || AI_ZOTERO_ID,
		version: data?.version || "0.0.0",
		rootURI,
		reason,
		shuttingDown: false,
	};
	aiZoteroRuntime = runtime;
	globalThis.__AIZoteroRuntime = runtime;

	try {
		runtime.modules = _loadModules(data, rootURI);
		runtime.service = _module(runtime.modules, "service", "aiService", "ai-zotero-service");
		runtime.ui = _module(runtime.modules, "ui", "presentation", "aiUI", "ai-zotero-ui");
		if (!runtime.service || !runtime.ui) {
			throw new Error("AI Zotero service or UI module is missing");
		}
		_createNamespace(runtime);
		_registerRuntimeFactory(runtime);
		await _registerIntegrations(runtime);
		_registerNotifier(runtime);
	}
	catch (error) {
		_debug(`Startup failed (${_safeErrorCode(error)})`, 1);
		await _shutdownRuntime(runtime);
		throw error;
	}
}

async function shutdown(data, reason) {
	if (aiZoteroRuntime) {
		await _shutdownRuntime(aiZoteroRuntime);
	}
	else if (Zotero.AIZotero?.id === AI_ZOTERO_ID) {
		delete Zotero.AIZotero;
	}
}
