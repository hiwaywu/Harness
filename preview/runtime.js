/**
 * preview/runtime.js
 *
 * A ~150-line stand-in for the two things the running app provides to a client plugin:
 *   1. window.__ModuleLoader__  (the AMD-ish loader that calls factory(require))
 *   2. React                    (only useState / useEffect / jsx-runtime are used by the row)
 *
 * The extension file itself (plugin/dsh-prompt-picker/lib/client.js) is loaded UNCHANGED, so what
 * renders here is the extension's real component tree, hooks order and fetch calls — only the host
 * around it is mocked. Anything that breaks in the app's loader/hooks contract breaks here too.
 */
(function () {
  "use strict";

  const Fragment = Symbol("Fragment");
  const slots = [];              // hook slots, one flat array: the row is the only component
  let cursor = 0;
  let pending = [];              // effects to run after the tree is inserted
  let scheduled = false;
  let mountEl = null;
  let currentLocale = "zh";

  /* ------------------------------------------------------------------ hooks */

  const react = {
    version: "preview-shim",
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      const set = (value) => {
        const next = typeof value === "function" ? value(slots[i]) : value;
        if (Object.is(next, slots[i])) return;
        slots[i] = next;
        schedule();
      };
      return [slots[i], set];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = slots[i];
      if (!prev) {
        slots[i] = { deps: deps || null };
        pending.push(fn);
        return;
      }
      if (!deps) return;                                   // no deps: run once, like React
      if (prev.deps && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))) return;
      slots[i] = { deps };
      pending.push(fn);
    },
    createElement: (type, props, ...children) => create(type, props, children),
  };

  function create(type, props, children) {
    const merged = Object.assign({}, props || {});
    if (children && children.length) merged.children = children.length === 1 ? children[0] : children;
    return { type, props: merged, key: merged.key };
  }

  const jsxRuntime = {
    Fragment,
    jsx: create,
    jsxs: create,
    jsxDEV: create,
  };

  /* ----------------------------------------------------------------- renderer */

  function renderNode(v) {
    if (v === null || v === undefined || v === true || v === false) return document.createTextNode("");
    if (typeof v === "string" || typeof v === "number") return document.createTextNode(String(v));
    if (Array.isArray(v)) {
      const frag = document.createDocumentFragment();
      for (const child of v) frag.appendChild(renderNode(child));
      return frag;
    }
    const type = v.type;
    const props = v.props || {};
    if (typeof type === "function") return renderNode(type(props));
    if (type === Fragment) return renderNode(props.children);

    const el = document.createElement(String(type));
    for (const key of Object.keys(props)) {
      const val = props[key];
      if (key === "children" || key === "key") continue;
      if (key === "style" && val && typeof val === "object") { Object.assign(el.style, val); continue; }
      if (key === "className") { el.setAttribute("class", String(val)); continue; }
      if (key === "value") continue;                       // applied after children exist
      if (/^on[A-Z]/.test(key) && typeof val === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), val);
        continue;
      }
      if (val === null || val === undefined || val === false) continue;
      el.setAttribute(key, val === true ? "" : String(val));
    }
    if (props.children !== undefined) el.appendChild(renderNode(props.children));
    if (props.value !== undefined) el.value = props.value;  // <select value=…> needs options first
    return el;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  }

  function render() {
    const Host = window.PreviewHost;
    if (!mountEl || !Host.component) return;
    cursor = 0;
    pending = [];
    const tree = renderNode(create(Host.component, { t: (key) => Host.t(key) }));
    mountEl.replaceChildren(tree);
    const effects = pending.slice();
    pending = [];
    for (const fn of effects) {
      try {
        const cleanup = fn();
        if (typeof cleanup === "function") Host.cleanups.push(cleanup);
      } catch (error) { console.error("preview: effect threw", error); }
    }
  }

  /* ------------------------------------------------------------- module loader */

  function makeRequire() {
    return (id) => {
      if (id === "react") return react;
      if (id === "react/jsx-runtime" || id === "react/jsx-dev-runtime") return jsxRuntime;
      throw new Error("preview: module not available: " + id);
    };
  }

  function makeCtx() {
    return {
      effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
      locale: {
        register(ns, dict) { window.PreviewHost.locales = dict; window.PreviewHost.localeNs = ns; return () => {}; },
      },
      slots: {
        inject(name, fn) { window.PreviewHost.injected.push(name); fn(); return () => {}; },
        register(spec, component) {
          window.PreviewHost.spec = spec;
          window.PreviewHost.component = component;
          return () => {};
        },
      },
    };
  }

  window.__ModuleLoader__ = {
    load(entry) {
      const exp = entry.factory(makeRequire());
      window.PreviewHost.entry = exp;
      window.PreviewHost.entryId = entry.id;
      window.PreviewHost.injectList = exp.inject || [];
      try {
        exp.apply(makeCtx());
      } catch (error) {
        console.error("preview: apply() threw — the app would log this and skip the row", error);
        window.PreviewHost.applyError = String(error && error.message ? error.message : error);
      }
    },
  };

  /* ------------------------------------------------------------------- host api */

  window.PreviewHost = {
    locales: {},
    localeNs: null,
    component: null,
    spec: null,
    entry: null,
    entryId: null,
    injectList: [],
    injected: [],
    applyError: null,
    cleanups: [],
    t(key) {
      const dict = this.locales[currentLocale] || this.locales.en || {};
      return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    },
    boot(el, localeId, statusEl) {
      mountEl = el;
      currentLocale = localeId || "zh";
      this.statusEl = statusEl || null;
      render();
      return {
        get component() { return window.PreviewHost.component; },
        get spec() { return window.PreviewHost.spec; },
      };
    },
    setLocale(localeId) { currentLocale = localeId; schedule(); },
    get locale() { return currentLocale; },
  };
})();
