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
			const [preview, setPreview] = (0, react.useState)(null);
			const [anchors, setAnchors] = (0, react.useState)([]);
			const [activeAnchor, setActiveAnchor] = (0, react.useState)("");

			const readPreview = (name) => {
				if (!name) { setPreview(null); return; }
				fetch("/prompt-picker/read?name=" + encodeURIComponent(name), { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((data) => {
						setPreview(data && data.ok
							? { text: data.text || "", bytes: data.bytes || 0, truncated: !!data.truncated }
							: null);
					})
					.catch(() => setPreview(null));
			};

			const load = () => {
				fetch("/prompt-picker/list", { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((data) => {
						setNames(Array.isArray(data.names) ? data.names : []);
						setActive(typeof data.active === "string" ? data.active : "");
						setAnchors(Array.isArray(data.anchors) ? data.anchors : []);
						setActiveAnchor(typeof data.activeAnchor === "string" ? data.activeAnchor : "");
						setStatus("");
						readPreview(typeof data.active === "string" ? data.active : "");
					})
					.catch(() => setStatus(t("loadFailed")));
			};

			const saveAnchor = () => {
				if (!activeAnchor) return;
				setStatus(t("saving"));
				fetch("/prompt-picker/set-anchor", {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ name: activeAnchor }),
				})
					.then((r) => r.json())
					.then((data) => setStatus(data && data.ok ? t("saved") : t("saveFailed")))
					.catch(() => setStatus(t("saveFailed")));
			};

			const createNew = () => {
				const input = typeof window !== "undefined" && window.prompt ? window.prompt(t("newPromptAsk"), "new-prompt.md") : null;
				if (!input) return;
				setStatus(t("saving"));
				fetch("/prompt-picker/new", {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify({ name: input, from: active }),
				})
					.then((r) => r.json())
					.then((data) => {
						if (!data || !data.ok) { setStatus((data && data.error) || t("saveFailed")); return; }
						setStatus(t("created") + " " + data.name);
						load();
					})
					.catch(() => setStatus(t("saveFailed")));
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
				style: { display: "flex", flexDirection: "column", gap: "8px", padding: "10px 0" },
				children: [
					react_jsx_runtime.jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px" },
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
									readPreview(event.target.value);
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
							react_jsx_runtime.jsx("button", {
								type: "button",
								onClick: createNew,
								style: { padding: "4px 12px", cursor: "pointer" },
								children: t("newPrompt"),
							}),
							react_jsx_runtime.jsx("span", {
								style: { fontSize: "12px", opacity: 0.8, minWidth: "120px" },
								children: status,
							}),
						],
					}),
					react_jsx_runtime.jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", borderTop: "1px solid rgba(127,127,127,0.2)", paddingTop: "8px" },
						children: [
							react_jsx_runtime.jsxs("div", {
								style: { flex: "1 1 auto", minWidth: "0" },
								children: [
									react_jsx_runtime.jsx("div", { style: { fontWeight: 600 }, children: t("anchorTitle") }),
									react_jsx_runtime.jsx("div", {
										style: { opacity: 0.7, fontSize: "12px" },
										children: t("anchorDescription"),
									}),
								],
							}),
							react_jsx_runtime.jsx("select", {
								value: activeAnchor,
								onChange: (event) => { setActiveAnchor(event.target.value); setStatus(""); },
								style: { minWidth: "220px", padding: "4px 6px" },
								children: anchors.map((n) => react_jsx_runtime.jsx("option", { value: n, children: n }, n)),
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								onClick: saveAnchor,
								disabled: !activeAnchor,
								style: { padding: "4px 12px", cursor: activeAnchor ? "pointer" : "default" },
								children: t("save"),
							}),
						],
					}),
					preview === null
						? null
						: react_jsx_runtime.jsxs("div", {
								style: { display: "flex", flexDirection: "column", gap: "2px" },
								children: [
									react_jsx_runtime.jsxs("div", {
										style: { fontSize: "11px", opacity: 0.65 },
										children: [
											t("previewLabel"),
											" — ",
											preview.bytes,
											" ",
											t("chars"),
											preview.truncated ? " (" + t("truncated") + ")" : "",
										],
									}),
									react_jsx_runtime.jsx("pre", {
										style: {
											margin: 0,
											maxHeight: "170px",
											overflow: "auto",
											whiteSpace: "pre-wrap",
											fontFamily: "ui-monospace,Consolas,monospace",
											fontSize: "11px",
											lineHeight: 1.35,
											background: "rgba(127,127,127,0.10)",
											border: "1px solid rgba(127,127,127,0.25)",
											borderRadius: "6px",
											padding: "8px",
										},
										children: preview.text || t("empty"),
									}),
								],
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
							newPrompt: "新建",
							newPromptAsk: "新提示词文件名（.md）",
							created: "已创建",
							previewLabel: "内容预览",
							chars: "字符",
							truncated: "已截断",
							empty: "（空文件）",
							anchorTitle: "尾部锚点",
							anchorDescription: "在提示词最后追加的规则；用于 A/B 对比",
						},
						en: {
							title: "Operator prompt",
							description: "Pick one from home/prompts; applies to new sessions after saving",
							save: "Save",
							saving: "Saving...",
							saved: "Saved - reopen the session to apply",
							loadFailed: "Could not load prompts",
							saveFailed: "Could not save",
							newPrompt: "New",
							newPromptAsk: "New prompt file name (.md)",
							created: "Created",
							previewLabel: "Preview",
							chars: "chars",
							truncated: "truncated",
							empty: "(empty file)",
							anchorTitle: "Tail anchor",
							anchorDescription: "Rules appended at the end of the prompt; A/B switch",
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
