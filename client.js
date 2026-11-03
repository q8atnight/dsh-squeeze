// dsh-squeeze — settings page (browser half), opened from Plugins → squeeze → Configure.
// Hand-written in DSH's client module format; React and the shared settings form come from the page.
window.__ModuleLoader__.load({
	id: "dsh-squeeze",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;

		const PACKAGE = "dsh-squeeze";
		const ENTRY = "dsh-squeeze"; // Host row id in cordis.patch.yml
		const NS = "dshSqueeze";
		const MAX_MODELS = 3;
		const NICKNAME = /^[a-z][a-z0-9-]{0,19}$/;

		// ---------- copy ----------
		const en = {
			summary: "Choose the helper models squeeze uses, when each should be used, and its limits.",
			unavailable: "The squeeze plugin is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "These settings were not accepted; they were left for you to correct.",
			conflicted: "These settings were changed somewhere else while you were editing. Discard your changes to load the new values, then edit again.",
			save: "Save",
			saving: "Saving…",
			overridden: "Changed",
			reset: "Reset to default",
			modelsTitle: "Helper models",
			modelsHint: "The agent picks a model by its nickname and sees your “when to use” note in its tool description. The first model is the default. The thinking level is fixed here; the agent cannot change it. Changes apply to new requests right away.",
			modelsNone: "No model chosen yet — squeeze then uses the DSH default model.",
			slotDefault: "Default model",
			slotExtra: "Extra model {n}",
			nickname: "Nickname",
			nicknameHint: "Short, lowercase, e.g. quick or careful.",
			model: "Model",
			chooseModel: "Choose a model…",
			unavailableModel: "{model} (not available right now)",
			thinking: "Thinking",
			thinkingDefault: "Model default",
			whenToUse: "When to use",
			whenToUsePlaceholder: "e.g. quick extraction from long pages; lists and facts",
			moveUp: "Move up",
			moveDown: "Move down",
			remove: "Remove",
			addModel: "Add model",
			loadingModels: "Loading the DSH model list…",
			loadFailed: "The DSH model list could not be loaded.",
			retry: "Retry",
			errNickname: "Nickname: start with a letter; only a–z, 0–9 and -; at most 20 characters.",
			errNicknameTaken: "This nickname is used twice.",
			errModel: "Choose a model.",
			errModelTwice: "This model is already in the list.",
			fallbackTitle: "Fallback",
			fallbackToggle: "Fall back to the next model when one fails",
			fallbackHint: "When on: if a model is unreachable, returns a server error, is no longer in the DSH model list, or the material is too big for it, the next model in the list is tried. A time-out does not fall back.",
			limitsTitle: "Limits",
			contextFillPercent: "Context fill (%)",
			contextFillPercentHint: "Share of each model's context window the material may use; the rest stays free for thinking and the answer. Default 80.",
			contextFillPercentInvalid: "Enter a whole number from 10 to 95.",
			outputTokens: "Output budget (tokens)",
			outputTokensHint: "Thinking plus answer, capped at each model's own maximum. Default 16,000.",
			outputTokensInvalid: "Enter a whole number of 1,000 or more.",
			callTimeoutSeconds: "Time limit per model call (seconds)",
			callTimeoutSecondsHint: "A call that takes longer is stopped and reported. Default 600.",
			callTimeoutSecondsInvalid: "Enter a whole number of 30 or more.",
			fetchTimeoutSeconds: "Time limit per web page download (seconds)",
			fetchTimeoutSecondsHint: "Default 30.",
			fetchTimeoutSecondsInvalid: "Enter a whole number of 5 or more.",
			maxUrls: "Web addresses per call",
			maxUrlsHint: "Default 20.",
			maxUrlsInvalid: "Enter a whole number from 1 to 50.",
			maxAnswerChars: "Longest answer (characters)",
			maxAnswerCharsHint: "Longer answers are cut at a line break and marked as cut. Default 6,000.",
			maxAnswerCharsInvalid: "Enter a whole number of 500 or more.",
			minPageChars: "Minimum page length (characters)",
			minPageCharsHint: "A single page with less text than this is usually a JavaScript-only or blocked page. Default 300.",
			minPageCharsInvalid: "Enter a whole number of 0 or more.",
			shortPages: "Pages under the minimum length",
			shortPagesReturn: "Hand the text to the agent as-is (no model call)",
			shortPagesRefuse: "Refuse with an error",
		};

		// ---------- helpers ----------
		const routeKey = (provider, model) => (provider && model ? `${provider}\u0000${model}` : "");
		const NUMBERS = [
			["contextFillPercent", 10, 95],
			["outputTokens", 1000, Infinity],
			["callTimeoutSeconds", 30, Infinity],
			["fetchTimeoutSeconds", 5, Infinity],
			["maxUrls", 1, 50],
			["maxAnswerChars", 500, Infinity],
			["minPageChars", 0, Infinity],
		];
		const parseWhole = (text, min, max) => {
			const t = String(text).replace(/[,\s_]/g, "");
			if (t === "") return { clear: true };
			if (!/^\d+$/.test(t)) return undefined;
			const n = Number(t);
			return Number.isSafeInteger(n) && n >= min && n <= max ? { value: n } : undefined;
		};

		function rowsFrom(models) {
			return (models ?? []).map((m) => ({ nickname: m.nickname ?? "", key: routeKey(m.provider, m.model), reasoningEffort: m.reasoningEffort ?? "", whenToUse: m.whenToUse ?? "" }));
		}

		// ---------- page controller ----------
		class SqueezeSettings {
			constructor(ctx) {
				this.ctx = ctx;
				this.scope = ctx.configForms.get(ENTRY);
				this.listeners = new Set();
				this.draft = undefined;
				this.draftRevision = undefined;
				this.catalog = { status: "idle", groups: [], byKey: new Map() };
				this.saving = false;
				this.failed = false;
				this.conflicted = false;
				this.disposed = false;
				this.snapshot = this.project();
				this.off = this.scope.subscribe(() => {
					const s = this.scope.getSnapshot();
					if (this.draft && !this.saving && s.revision !== this.draftRevision) this.conflicted = true;
					this.publish();
				});
			}
			subscribe = (fn) => {
				this.listeners.add(fn);
				if (this.catalog.status === "idle") this.loadCatalog();
				return () => this.listeners.delete(fn);
			};
			getSnapshot = () => this.snapshot;
			publish() {
				this.snapshot = this.project();
				for (const fn of this.listeners) fn();
			}
			dispose() {
				this.disposed = true;
				this.off?.();
			}
			current() {
				const v = this.scope.getSnapshot().value ?? {};
				return {
					rows: rowsFrom(v.models),
					fallback: v.fallback === true,
					shortPages: v.shortPages ?? "return",
					numbers: Object.fromEntries(NUMBERS.map(([f]) => [f, v[f] === undefined ? "" : String(v[f])])),
				};
			}
			begin() {
				if (!this.draft) {
					const c = this.current();
					this.draft = { rows: c.rows.map((r) => ({ ...r })), fallback: c.fallback, shortPages: c.shortPages, numbers: { ...c.numbers }, cleared: new Set() };
					this.draftRevision = this.scope.getSnapshot().revision;
				}
				this.failed = false;
				return this.draft;
			}
			view() {
				return this.draft ?? { ...this.current(), cleared: new Set() };
			}
			// --- edits ---
			editRow = (i, field, value) => {
				const d = this.begin();
				const row = { ...d.rows[i], [field]: value };
				if (field === "key") {
					const efforts = this.catalog.byKey.get(value)?.efforts ?? [];
					if (row.reasoningEffort && !efforts.some((e) => e.id === row.reasoningEffort)) row.reasoningEffort = "";
				}
				d.rows[i] = row;
				this.publish();
			};
			addRow = () => {
				const d = this.begin();
				if (d.rows.length >= MAX_MODELS) return;
				d.rows.push({ nickname: "", key: "", reasoningEffort: "", whenToUse: "" });
				this.publish();
			};
			removeRow = (i) => {
				const d = this.begin();
				d.rows.splice(i, 1);
				this.publish();
			};
			moveRow = (i, delta) => {
				const d = this.begin();
				const j = i + delta;
				if (j < 0 || j >= d.rows.length) return;
				[d.rows[i], d.rows[j]] = [d.rows[j], d.rows[i]];
				this.publish();
			};
			setFallback = (on) => {
				this.begin().fallback = on;
				this.publish();
			};
			setShortPages = (value) => {
				this.begin().shortPages = value;
				this.publish();
			};
			editNumber = (field, text) => {
				const d = this.begin();
				d.numbers[field] = text;
				d.cleared.delete(field);
				this.publish();
			};
			resetNumber = (field) => {
				const d = this.begin();
				d.cleared.add(field);
				this.publish();
			};
			discard = () => {
				if (this.saving) return;
				this.draft = undefined;
				this.draftRevision = undefined;
				this.failed = false;
				this.conflicted = false;
				this.publish();
			};
			// --- validation ---
			rowErrors(rows) {
				return rows.map((r, i) => {
					const errors = [];
					if (!NICKNAME.test(r.nickname)) errors.push("errNickname");
					else if (rows.some((o, j) => j !== i && o.nickname === r.nickname)) errors.push("errNicknameTaken");
					if (!r.key) errors.push("errModel");
					else if (rows.some((o, j) => j < i && o.key === r.key)) errors.push("errModelTwice");
					return errors;
				});
			}
			ops() {
				const d = this.draft;
				if (!d) return [];
				const c = this.current();
				const user = this.scope.getSnapshot().user ?? {};
				const ops = [];
				const models = d.rows.map((r) => {
					const [provider, model] = r.key.split("\u0000");
					const out = { nickname: r.nickname, provider, model };
					if (r.reasoningEffort) out.reasoningEffort = r.reasoningEffort;
					if (r.whenToUse.trim()) out.whenToUse = r.whenToUse.trim();
					return out;
				});
				if (JSON.stringify(rowsFrom(models)) !== JSON.stringify(c.rows)) ops.push({ op: "set", path: ["models"], value: models });
				if (d.fallback !== c.fallback) ops.push({ op: "set", path: ["fallback"], value: d.fallback });
				if (d.shortPages !== c.shortPages) ops.push({ op: "set", path: ["shortPages"], value: d.shortPages });
				for (const [f, min, max] of NUMBERS) {
					if (d.cleared.has(f)) {
						if (Object.hasOwn(user, f)) ops.push({ op: "unset", path: [f] });
						continue;
					}
					if (d.numbers[f] === c.numbers[f]) continue;
					const p = parseWhole(d.numbers[f], min, max);
					if (p?.clear) {
						if (Object.hasOwn(user, f)) ops.push({ op: "unset", path: [f] });
					} else if (p) ops.push({ op: "set", path: [f], value: p.value });
				}
				return ops;
			}
			save = async () => {
				const s = this.snapshot;
				if (!s.available || !s.writable || !s.dirty || s.invalid || this.saving) return;
				if (this.conflicted) return;
				const ops = this.ops();
				if (!ops.length) return this.discard();
				this.saving = true;
				this.publish();
				const ok = await this.scope.mutate(ops, this.draftRevision);
				if (this.disposed) return;
				this.saving = false;
				if (ok) {
					this.draft = undefined;
					this.draftRevision = undefined;
					this.conflicted = false;
				} else this.failed = true;
				this.publish();
			};
			// --- model list ---
			async loadCatalog() {
				if (this.disposed || this.catalog.status === "loading") return;
				this.catalog = { ...this.catalog, status: "loading" };
				this.publish();
				let response;
				try {
					response = await this.ctx.remote.session.modelCatalog();
				} catch (e) {
					response = { ok: false };
				}
				if (this.disposed) return;
				if (response?.ok) {
					const byKey = new Map();
					for (const g of response.value.groups) for (const m of g.models) byKey.set(routeKey(g.id, m.id), { provider: g.id, providerName: g.name, model: m.id, name: m.name, efforts: m.reasoning?.efforts ?? [] });
					this.catalog = { status: "ready", groups: response.value.groups, byKey };
				} else this.catalog = { ...this.catalog, status: "error" };
				this.publish();
			}
			refreshCatalog = () => {
				this.catalog = { ...this.catalog, status: "idle" };
				this.loadCatalog();
			};
			// --- projection for the view ---
			project() {
				const snap = this.scope.getSnapshot();
				const view = this.view();
				const rowErrors = this.rowErrors(view.rows);
				const user = snap.user ?? {};
				const numbers = NUMBERS.map(([f, min, max]) => {
					const cleared = view.cleared.has(f);
					const base = snap.base?.[f];
					const text = cleared ? (base === undefined ? "" : String(base)) : view.numbers[f];
					const invalid = !cleared && parseWhole(text, min, max) === undefined;
					return { field: f, text, invalid, overridden: !cleared && Object.hasOwn(user, f) };
				});
				const invalid = rowErrors.some((e) => e.length > 0) || numbers.some((n) => n.invalid) || view.rows.length > MAX_MODELS;
				return {
					available: snap.status === "ready",
					writable: snap.writable === true,
					dirty: this.draft !== undefined && this.ops().length > 0,
					invalid: invalid || this.conflicted,
					saving: this.saving,
					failed: this.failed,
					conflicted: this.conflicted,
					rows: view.rows,
					rowErrors,
					fallback: view.fallback,
					shortPages: view.shortPages,
					numbers,
					catalog: this.catalog,
				};
			}
		}

		// ---------- view ----------
		const CSS = `
.dsq-section{display:grid;gap:12px;padding:16px 0;min-width:0}
.dsq-section+.dsq-section{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsq-h{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsq-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsq-error{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dsq-card{display:grid;gap:10px;padding:12px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:10px;background:var(--dsw-alias-settings-card-fill,transparent)}
.dsq-cardhead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsq-slot{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsq-actions{display:flex;gap:4px}
.dsq-grid{display:grid;grid-template-columns:minmax(120px,1fr) minmax(200px,2fr) minmax(120px,1fr);gap:10px}
@media (max-width:720px){.dsq-grid{grid-template-columns:1fr}}
.dsq-field{display:grid;gap:4px;min-width:0}
.dsq-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsq-input,.dsq-select,.dsq-textarea{box-sizing:border-box;width:100%;min-width:0;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px}
.dsq-textarea{resize:vertical;min-height:52px;line-height:1.4}
.dsq-input[aria-invalid=true],.dsq-select[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dsq-input:focus,.dsq-select:focus,.dsq-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsq-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;cursor:pointer}
.dsq-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsq-btn:disabled{opacity:.45;cursor:default}
.dsq-add{justify-self:start}
.dsq-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsq-limits{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
`;

		const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ""));

		function ModelCard({ t, state, i, ctl, disabled }) {
			const row = state.rows[i];
			const errors = state.rowErrors[i];
			const cat = state.catalog;
			const entry = cat.byKey.get(row.key);
			const efforts = entry?.efforts ?? [];
			const id = `dsq-${i}`;
			const options = [h("option", { key: "", value: "" }, t("chooseModel"))];
			if (row.key && !entry && cat.status === "ready") {
				options.push(h("option", { key: row.key, value: row.key }, fill(t("unavailableModel"), { model: row.key.replace("\u0000", " / ") })));
			} else if (row.key && !entry) {
				options.push(h("option", { key: row.key, value: row.key }, row.key.replace("\u0000", " / ")));
			}
			for (const g of cat.groups) {
				options.push(h("optgroup", { key: `g:${g.id}`, label: g.name }, g.models.map((m) => h("option", { key: routeKey(g.id, m.id), value: routeKey(g.id, m.id) }, m.name))));
			}
			const effortOptions = [h("option", { key: "", value: "" }, t("thinkingDefault")), ...efforts.map((e) => h("option", { key: e.id, value: e.id }, e.name ?? e.id))];
			if (row.reasoningEffort && !efforts.some((e) => e.id === row.reasoningEffort)) effortOptions.push(h("option", { key: row.reasoningEffort, value: row.reasoningEffort }, row.reasoningEffort));
			return h(
				"div",
				{ className: "dsq-card" },
				h(
					"div",
					{ className: "dsq-cardhead" },
					h("span", { className: "dsq-slot" }, i === 0 ? t("slotDefault") : fill(t("slotExtra"), { n: i })),
					h(
						"span",
						{ className: "dsq-actions" },
						h("button", { type: "button", className: "dsq-btn", disabled: disabled || i === 0, onClick: () => ctl.moveRow(i, -1), title: t("moveUp"), "aria-label": t("moveUp") }, "↑"),
						h("button", { type: "button", className: "dsq-btn", disabled: disabled || i === state.rows.length - 1, onClick: () => ctl.moveRow(i, 1), title: t("moveDown"), "aria-label": t("moveDown") }, "↓"),
						h("button", { type: "button", className: "dsq-btn", disabled, onClick: () => ctl.removeRow(i) }, t("remove")),
					),
				),
				h(
					"div",
					{ className: "dsq-grid" },
					h(
						"label",
						{ className: "dsq-field", htmlFor: `${id}-nick` },
						h("span", { className: "dsq-label" }, t("nickname")),
						h("input", { id: `${id}-nick`, className: "dsq-input", value: row.nickname, placeholder: i === 0 ? "quick" : i === 1 ? "careful" : "", disabled, "aria-invalid": errors.some((e) => e.startsWith("errNickname")), onChange: (e) => ctl.editRow(i, "nickname", e.target.value.toLowerCase()) }),
					),
					h(
						"label",
						{ className: "dsq-field", htmlFor: `${id}-model` },
						h("span", { className: "dsq-label" }, t("model")),
						h("select", { id: `${id}-model`, className: "dsq-select", value: row.key, disabled, "aria-invalid": errors.some((e) => e.startsWith("errModel")), onChange: (e) => ctl.editRow(i, "key", e.target.value) }, options),
					),
					h(
						"label",
						{ className: "dsq-field", htmlFor: `${id}-think` },
						h("span", { className: "dsq-label" }, t("thinking")),
						h("select", { id: `${id}-think`, className: "dsq-select", value: row.reasoningEffort, disabled: disabled || (!efforts.length && !row.reasoningEffort), onChange: (e) => ctl.editRow(i, "reasoningEffort", e.target.value) }, effortOptions),
					),
				),
				h(
					"label",
					{ className: "dsq-field", htmlFor: `${id}-when` },
					h("span", { className: "dsq-label" }, t("whenToUse")),
					h("textarea", { id: `${id}-when`, className: "dsq-textarea", rows: 2, maxLength: 400, value: row.whenToUse, placeholder: t("whenToUsePlaceholder"), disabled, onChange: (e) => ctl.editRow(i, "whenToUse", e.target.value) }),
				),
				errors.length ? h("p", { className: "dsq-error", role: "alert" }, errors.map((e) => t(e)).join(" ")) : null,
			);
		}

		function makePage(ctl) {
			return function SqueezePage({ t, view }) {
				const state = React.useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
				if (view === "summary") return t("summary");
				const disabled = !state.writable || state.saving;
				const cat = state.catalog;
				return h(
					ui.SettingsForm,
					{ labels: { unavailable: t("unavailable"), readOnly: t("readOnly"), saveFailed: t("saveFailed"), save: t("save"), saving: t("saving") }, state, onSave: ctl.save, onDiscard: ctl.discard },
					state.conflicted ? h("p", { className: "dsq-error", role: "alert" }, t("conflicted")) : null,
					h(
						"section",
						{ className: "dsq-section" },
						h("h3", { className: "dsq-h" }, t("modelsTitle")),
						h("p", { className: "dsq-hint" }, t("modelsHint")),
						cat.status === "loading" ? h("p", { className: "dsq-hint", role: "status" }, t("loadingModels")) : null,
						cat.status === "error" ? h("p", { className: "dsq-error", role: "alert" }, t("loadFailed"), " ", h("button", { type: "button", className: "dsq-btn", onClick: ctl.refreshCatalog }, t("retry"))) : null,
						state.rows.length === 0 ? h("p", { className: "dsq-hint" }, t("modelsNone")) : null,
						state.rows.map((_r, i) => h(ModelCard, { key: i, t, state, i, ctl, disabled })),
						state.rows.length < MAX_MODELS ? h("button", { type: "button", className: "dsq-btn dsq-add", disabled, onClick: ctl.addRow }, `+ ${t("addModel")}`) : null,
					),
					h(
						"section",
						{ className: "dsq-section" },
						h("h3", { className: "dsq-h" }, t("fallbackTitle")),
						h("div", { className: "dsq-toggle" }, h("span", null, t("fallbackToggle")), h(ui.Switch, { checked: state.fallback, label: t("fallbackToggle"), disabled, onChange: (checked) => ctl.setFallback(checked) })),
						h("p", { className: "dsq-hint" }, t("fallbackHint")),
					),
					h(
						"section",
						{ className: "dsq-section" },
						h("h3", { className: "dsq-h" }, t("limitsTitle")),
						h(
							"div",
							{ className: "dsq-limits" },
							state.numbers.map((n) =>
								h(ui.SettingsValueField, {
									key: n.field,
									id: `dsq-${n.field}`,
									label: t(n.field),
									hint: t(`${n.field}Hint`),
									invalidLabel: t(`${n.field}Invalid`),
									overriddenLabel: t("overridden"),
									resetLabel: t("reset"),
									numeric: true,
									disabled,
									text: n.text,
									invalid: n.invalid,
									overridden: n.overridden,
									onEdit: (text) => ctl.editNumber(n.field, text),
									onReset: () => ctl.resetNumber(n.field),
								}),
							),
							h(
								"label",
								{ className: "dsq-field", htmlFor: "dsq-shortPages" },
								h("span", { className: "dsq-label" }, t("shortPages")),
								h(
									"select",
									{ id: "dsq-shortPages", className: "dsq-select", value: state.shortPages, disabled, onChange: (e) => ctl.setShortPages(e.target.value) },
									h("option", { value: "return" }, t("shortPagesReturn")),
									h("option", { value: "refuse" }, t("shortPagesRefuse")),
								),
							),
						),
					),
				);
			};
		}

		// ---------- plugin entry ----------
		const inject = ["slots", "locale", "remote", "remote.session", "configForms"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh: en }), "dsh-squeeze: dictionary");
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = PACKAGE;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => tag.remove();
			}, "dsh-squeeze: styles");
			const ctl = new SqueezeSettings(ctx);
			ctx.effect(() => () => ctl.dispose(), "dsh-squeeze: settings form");
			ctx.effect(() => ctx.remote.$on("llm/adapters-updated", () => ctl.refreshCatalog()), "dsh-squeeze: model list changes");
			ctx.effect(() => ctx.on("connection/reset", () => { ctl.discard(); ctl.refreshCatalog(); }), "dsh-squeeze: reconnect");
			const Page = makePage(ctl);
			ctx.effect(
				() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({ name: "plugins.row.config", key: `${PACKAGE}#${ENTRY}`, locale: NS }, Page)),
				"dsh-squeeze: configure page",
			);
			// Also show the same form directly on the bundle's detail page (between description and rows).
			ctx.effect(
				() => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({ name: "plugins.bundle.config", key: PACKAGE, locale: NS }, Page)),
				"dsh-squeeze: bundle page",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
