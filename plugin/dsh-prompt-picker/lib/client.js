window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-prompt-picker",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		const NS = "settings.promptPicker";

		function PromptPickerRow({ t }) {
			const [names, setNames] = (0, react.useState)([]);
			const [active, setActive] = (0, react.useState)("");
			const [status, setStatus] = (0, react.useState)("");

			const load = () => {
				fetch("/prompt-picker/list", { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((data) => {
						setNames(Array.isArray(data.names) ? data.names : []);
						setActive(typeof data.active === "string" ? data.active : "");
						setStatus("");
					})
					.catch(() => setStatus(t("loadFailed")));
			};

			(0, react.useEffect)(() => {
				load();
			}, []);

			const save = () => {
				if (!active) return;
				setStatus(t("saving"));
				fetch("/prompt-picker/set", {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ name: active }),
				})
					.then((r) => r.json())
					.then((data) => setStatus(data && data.ok ? t("saved") : t("saveFailed")))
					.catch(() => setStatus(t("saveFailed")));
			};

			if (names.length === 0 && status === "") return null;

			return react_jsx_runtime.jsxs("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: "10px",
					padding: "10px 0",
				},
				children: [
					react_jsx_runtime.jsxs("div", {
						style: { flex: "1 1 auto", minWidth: "0" },
						children: [
							react_jsx_runtime.jsx("div", { style: { fontWeight: 600 }, children: t("title") }),
							react_jsx_runtime.jsx("div", {
								style: { opacity: 0.7, fontSize: "12px" },
								children: t("description"),
							}),
						],
					}),
					react_jsx_runtime.jsx("select", {
						value: active,
						onChange: (event) => {
							setActive(event.target.value);
							setStatus("");
						},
						style: { minWidth: "220px", padding: "4px 6px" },
						children: names.map((n) => react_jsx_runtime.jsx("option", { value: n, children: n }, n)),
					}),
					react_jsx_runtime.jsx("button", {
						type: "button",
						onClick: save,
						disabled: !active,
						style: { padding: "4px 12px", cursor: active ? "pointer" : "default" },
						children: t("save"),
					}),
					react_jsx_runtime.jsx("span", {
						style: { fontSize: "12px", opacity: 0.8, minWidth: "120px" },
						children: status,
					}),
				],
			});
		}

		function apply(ctx) {
			// Never let this optional row abort web boot (a failed entry is fatal to the desktop app).
			try {
				applyRow(ctx);
			} catch (error) {
				console.error("prompt-picker: settings row disabled", error);
			}
		}

		function applyRow(ctx) {
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						zh: {
							title: "操作者提示词",
							description: "从 home/prompts 选择一个，保存后新会话生效",
							save: "保存",
							saving: "保存中…",
							saved: "已保存，重开会话生效",
							loadFailed: "读取失败",
							saveFailed: "保存失败",
						},
						en: {
							title: "Operator prompt",
							description: "Pick one from home/prompts; applies to new sessions after saving",
							save: "Save",
							saving: "Saving...",
							saved: "Saved - reopen the session to apply",
							loadFailed: "Could not load prompts",
							saveFailed: "Could not save",
						},
					}),
				"prompt-picker: locale",
			);

			ctx.slots.inject("settings.general.item", () =>
				ctx.slots.register(
					{
						name: "settings.general.item",
						id: "prompt-picker",
						order: -19,
						locale: NS,
					},
					PromptPickerRow,
				),
			);
		}

		// Services the loader must provide before apply() runs; without this ctx.slots/ctx.locale
		// are undefined, apply throws, and web boot treats the failed entry as fatal (app exits).
		const inject = ["slots", "locale"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
