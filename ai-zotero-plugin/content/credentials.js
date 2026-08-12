(function (root) {
	"use strict";

	var modules = root.__AIZoteroModules || (root.__AIZoteroModules = {});
	var constants = modules.constants;
	var utils = modules.utils;
	var errors = modules.errors;
	if (typeof module !== "undefined" && module.exports && typeof require === "function") {
		constants = constants || require("./constants.js");
		utils = utils || require("./utils.js");
		errors = errors || require("./errors.js");
	}

	function resolveLoginManager(loginManager) {
		if (loginManager) {
			return loginManager;
		}
		if (root.Services && root.Services.logins) {
			return root.Services.logins;
		}
		throw errors.createCredentialError("login-manager-unavailable");
	}

	function normalizeProviderID(provider) {
		var providerID = typeof provider === "string" ? provider.trim().toLowerCase() : "";
		if (!constants.PROVIDER_IDS.includes(providerID)) {
			throw errors.createCredentialError("unknown-provider");
		}
		return providerID;
	}

	function realmForProvider(provider) {
		var providerID = normalizeProviderID(provider);
		return constants.LOGIN_MANAGER_REALM_PREFIX + " (" + providerID + ")";
	}

	function usernameForProvider(provider) {
		return constants.LOGIN_MANAGER_USERNAME_PREFIX + normalizeProviderID(provider);
	}

	function makeLoginInfo(options) {
		if (typeof options.loginInfoFactory === "function") {
			return options.loginInfoFactory({
				origin: options.origin,
				realm: options.realm,
				username: options.username,
				password: options.password
			});
		}
		var ComponentsObject = root.Components;
		if (!ComponentsObject || typeof ComponentsObject.Constructor !== "function"
				|| !ComponentsObject.interfaces || !ComponentsObject.interfaces.nsILoginInfo) {
			throw errors.createCredentialError("login-info-constructor-unavailable");
		}
		var LoginInfo = ComponentsObject.Constructor(
			"@mozilla.org/login-manager/loginInfo;1",
			ComponentsObject.interfaces.nsILoginInfo,
			"init"
		);
		return new LoginInfo(
			options.origin,
			null,
			options.realm,
			options.username,
			options.password,
			"",
			""
		);
	}

	class CredentialStore {
		constructor(options) {
			options = options || {};
			this.loginManager = resolveLoginManager(options.loginManager);
			this.origin = options.origin || constants.LOGIN_MANAGER_ORIGIN;
			this.loginInfoFactory = options.loginInfoFactory;
		}

		async _search(provider) {
			var providerID = normalizeProviderID(provider);
			if (typeof this.loginManager.searchLoginsAsync !== "function") {
				throw errors.createCredentialError("async-login-search-unavailable");
			}
			var logins;
			try {
				logins = await this.loginManager.searchLoginsAsync({
					origin: this.origin,
					httpRealm: realmForProvider(providerID)
				});
			}
			catch (error) {
				throw errors.createCredentialError("async-login-search-failed");
			}
			if (!Array.isArray(logins)) {
				return [];
			}
			return logins.filter(login => login && login.username === usernameForProvider(providerID));
		}

		async get(provider) {
			var logins = await this._search(provider);
			return logins.length && typeof logins[0].password === "string" ? logins[0].password : null;
		}

		async has(provider) {
			return Boolean((await this._search(provider)).length);
		}

		async save(provider, apiKey) {
			var providerID = normalizeProviderID(provider);
			try {
				apiKey = utils.asNonEmptyString(apiKey, "API key", 4096);
			}
			catch (error) {
				throw errors.createCredentialError("invalid-api-key");
			}
			var existing = await this._search(providerID);
			var loginInfo = makeLoginInfo({
				origin: this.origin,
				realm: realmForProvider(providerID),
				username: usernameForProvider(providerID),
				password: apiKey,
				loginInfoFactory: this.loginInfoFactory
			});
			try {
				if (existing.length) {
					if (typeof this.loginManager.modifyLoginAsync !== "function") {
						throw errors.createCredentialError("async-login-modify-unavailable");
					}
					await this.loginManager.modifyLoginAsync(existing[0], loginInfo);
					for (var duplicate of existing.slice(1)) {
						if (typeof this.loginManager.removeLoginAsync === "function") {
							await this.loginManager.removeLoginAsync(duplicate);
						}
					}
				}
				else {
					if (typeof this.loginManager.addLoginAsync !== "function") {
						throw errors.createCredentialError("async-login-add-unavailable");
					}
					await this.loginManager.addLoginAsync(loginInfo);
				}
			}
			catch (error) {
				if (error instanceof errors.AIZoteroError) {
					throw error;
				}
				throw errors.createCredentialError("async-login-save-failed");
			}
			return { provider: providerID, configured: true };
		}

		async remove(provider) {
			var providerID = normalizeProviderID(provider);
			var existing = await this._search(providerID);
			if (typeof this.loginManager.removeLoginAsync !== "function") {
				throw errors.createCredentialError("async-login-remove-unavailable");
			}
			try {
				for (var login of existing) {
					await this.loginManager.removeLoginAsync(login);
				}
			}
			catch (error) {
				throw errors.createCredentialError("async-login-remove-failed");
			}
			return { provider: providerID, removed: existing.length };
		}

		async replace(provider, apiKey) {
			return this.save(provider, apiKey);
		}

		async clear(provider) {
			return this.remove(provider);
		}

		async masked(provider) {
			var apiKey = await this.get(provider);
			if (!apiKey) {
				return null;
			}
			var visibleSuffix = apiKey.length > 4 ? apiKey.slice(-4) : "";
			return "••••••••" + visibleSuffix;
		}

		async metadata() {
			var result = {};
			for (var providerID of constants.PROVIDER_IDS) {
				result[providerID] = await this.has(providerID);
			}
			return result;
		}
	}

	function createCredentialStore(options) {
		return new CredentialStore(options);
	}

	var defaultStore;
	function getDefaultStore() {
		if (!defaultStore) {
			defaultStore = new CredentialStore();
		}
		return defaultStore;
	}

	function operationArguments(providerOrOptions, value) {
		if (providerOrOptions && typeof providerOrOptions === "object") {
			return {
				provider: providerOrOptions.provider,
				value: providerOrOptions.value
			};
		}
		return { provider: providerOrOptions, value };
	}

	async function getKey(provider) {
		return getDefaultStore().get(provider);
	}

	async function getStatus(provider) {
		return getDefaultStore().has(provider);
	}

	async function save(providerOrOptions, value) {
		var args = operationArguments(providerOrOptions, value);
		return getDefaultStore().save(args.provider, args.value);
	}

	async function remove(providerOrOptions) {
		var args = operationArguments(providerOrOptions);
		return getDefaultStore().remove(args.provider);
	}

	var credentials = {
		CredentialStore,
		LoginManagerCredentials: CredentialStore,
		createCredentialStore,
		realmForProvider,
		usernameForProvider,
		getKey,
		getStatus,
		status: getStatus,
		hasCredential: getStatus,
		save,
		set: save,
		store: save,
		remove,
		delete: remove,
		clear: remove
	};

	modules.credentials = credentials;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = credentials;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
