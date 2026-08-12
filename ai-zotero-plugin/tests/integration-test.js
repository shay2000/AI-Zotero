/* global describe, it, assert */

"use strict";

describe("AI for Zotero integration contracts", function () {
	it("exposes the expected module registry", function () {
		assert.isObject(globalThis.__AIZoteroModules);
		assert.isFunction(globalThis.__AIZoteroModules?.Runtime);
	});

	it("does not expose credentials on the public runtime namespace", function () {
		let api = Zotero.AIZotero;
		if (!api) return;
		assert.notProperty(api, "apiKeys");
		assert.notProperty(api, "credentials");
		assert.notProperty(api, "getAPIKey");
	});
});
