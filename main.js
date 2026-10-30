var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => PlantUMLRendererPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_crypto = require("crypto");

// src/DiagramBlock.ts
function firstBlock(lines) {
  const start = lines.findIndex((l) => /^\s*@start\w+/i.test(l));
  if (start < 0) return null;
  const type = lines[start].match(/@start(\w+)/i)[1];
  const endLine = new RegExp(`^\\s*@end${type}\\s*$`, "i");
  const end = lines.findIndex((l, i) => i > start && endLine.test(l));
  return { type, start, end };
}

// src/IncludePaths.ts
var import_promises = require("fs/promises");
var path = __toESM(require("path"));
async function resolveVaultInclude(vaultPath, notePath, includePath) {
  const root = path.resolve(vaultPath);
  if (path.isAbsolute(includePath)) throw new Error("Include is outside vault");
  const candidate = path.resolve(root, path.dirname(notePath), includePath);
  const inside = (location, base) => {
    const relative2 = path.relative(base, location);
    return relative2 === "" || relative2 !== ".." && !relative2.startsWith(`..${path.sep}`) && !path.isAbsolute(relative2);
  };
  if (!inside(candidate, root)) throw new Error("Include is outside vault");
  const [realRoot, realCandidate] = await Promise.all([(0, import_promises.realpath)(root), (0, import_promises.realpath)(candidate)]);
  if (!inside(realCandidate, realRoot)) throw new Error("Include is outside vault");
  return path.relative(realRoot, realCandidate).split(path.sep).join("/");
}

// src/PlantUMLPipe.ts
var import_child_process = require("child_process");
function terminate(source) {
  const lines = source.split("\n");
  const block = firstBlock(lines);
  if (!block) return `@startuml
${source}
@enduml`;
  if (block.end < 0) return [...lines.slice(block.start), `@end${block.type}`].join("\n");
  return lines.slice(block.start, block.end + 1).join("\n");
}
var PlantUMLPipe = class {
  constructor(javaPath, jarPath, dotPath, nativePath = "", layout = "graphviz") {
    this.javaPath = javaPath;
    this.jarPath = jarPath;
    this.dotPath = dotPath;
    this.nativePath = nativePath;
    this.layout = layout;
    this.proc = null;
    this.outBuf = "";
    this.pending = null;
    this.queue = [];
  }
  render(source) {
    return new Promise((resolve2, reject) => {
      this.queue.push({ source, resolve: resolve2, reject });
      if (!this.pending) this.next();
    });
  }
  kill() {
    var _a, _b;
    (_a = this.proc) == null ? void 0 : _a.kill();
    this.proc = null;
    const err = new Error("PlantUML pipe closed");
    (_b = this.pending) == null ? void 0 : _b.reject(err);
    this.pending = null;
    this.queue.forEach((item) => item.reject(err));
    this.queue = [];
  }
  next() {
    if (this.queue.length === 0) return;
    const item = this.queue.shift();
    this.pending = item;
    try {
      this.ensureRunning();
      this.proc.stdin.write(terminate(item.source) + "\n");
    } catch (err) {
      this.pending = null;
      item.reject(err instanceof Error ? err : new Error(String(err)));
      this.next();
    }
  }
  ensureRunning() {
    if (this.proc && !this.proc.killed) return;
    const args = ["-Dfile.encoding=UTF-8", "-DPLANTUML_SECURITY_PROFILE=SANDBOX"];
    if (!this.nativePath) args.push("-jar", this.jarPath);
    args.push("-tsvg", "-pipe");
    if (this.layout === "smetana") args.push("-Playout=smetana");
    else if (this.dotPath) args.push("-graphvizdot", this.dotPath);
    this.proc = (0, import_child_process.spawn)(this.nativePath || this.javaPath, args);
    this.outBuf = "";
    this.proc.stdout.on("data", (chunk) => {
      this.outBuf += chunk.toString("utf-8");
      let end;
      while ((end = this.outBuf.indexOf("</svg>")) !== -1) {
        const svg = this.outBuf.slice(0, end + 6);
        this.outBuf = this.outBuf.slice(end + 6);
        if (!this.pending) break;
        const p = this.pending;
        this.pending = null;
        p.resolve(svg);
        this.next();
      }
    });
    this.proc.stderr.on("data", () => {
    });
    this.proc.stdin.on("error", (err) => {
      const p = this.pending;
      this.pending = null;
      this.proc = null;
      p == null ? void 0 : p.reject(err);
      this.queue.forEach((item) => item.reject(err));
      this.queue = [];
    });
    this.proc.on("error", (err) => {
      const p = this.pending;
      this.pending = null;
      this.proc = null;
      p == null ? void 0 : p.reject(err);
      this.queue.forEach((item) => item.reject(err));
      this.queue = [];
    });
    this.proc.on("close", (code) => {
      this.proc = null;
      const err = new Error(`PlantUML process exited unexpectedly (code ${code})`);
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.reject(err);
      }
      this.queue.forEach((item) => item.reject(err));
      this.queue = [];
    });
  }
};

// src/main.ts
var DEFAULT_SETTINGS = {
  nativePath: "",
  jarPath: "",
  javaPath: "/usr/bin/java",
  dotPath: "/opt/homebrew/bin/dot",
  layoutEngine: "graphviz"
};
function guard(vaultPath, content) {
  const id = `$__include_${(0, import_crypto.createHash)("sha1").update(vaultPath).digest("hex").slice(0, 12)}`;
  return `!if %not(%variable_exists("${id}"))
!global ${id} = %true()
${content}
!endif`;
}
function unwrap(content) {
  const lines = content.split("\n");
  const block = firstBlock(lines);
  if (!block) return content;
  return lines.slice(block.start + 1, block.end < 0 ? void 0 : block.end).join("\n");
}
var OPENS = /^\s*!(?:if|ifdef|ifndef|while|foreach|procedure|function|unquoted\s+(?:procedure|function))\b(?!.*!return\b)/i;
var CLOSES = /^\s*!(?:endif|endwhile|endfor|endprocedure|endfunction)\b/i;
var CACHE_LIMIT = 30;
var PlantUMLRendererPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.pipe = null;
    this.svgCache = /* @__PURE__ */ new Map();
  }
  async onload() {
    await this.loadSettings();
    this.startPipe();
    this.registerMarkdownCodeBlockProcessor("plantuml", (source, el, ctx) => {
      return this.render(source, el, ctx);
    });
    this.addSettingTab(new SettingsTab(this.app, this));
  }
  onunload() {
    var _a;
    (_a = this.pipe) == null ? void 0 : _a.kill();
  }
  startPipe() {
    var _a;
    (_a = this.pipe) == null ? void 0 : _a.kill();
    this.svgCache.clear();
    const { nativePath, javaPath, jarPath, dotPath, layoutEngine } = this.settings;
    this.pipe = nativePath || jarPath ? new PlantUMLPipe(javaPath, jarPath, dotPath, nativePath, layoutEngine) : null;
  }
  async render(source, el, ctx) {
    var _a, _b, _c, _d, _e;
    try {
      if (!this.pipe) throw new Error("PlantUML not configured \u2014 set the native binary or JAR path in plugin settings.");
      const resolved = await this.resolveIncludes(source, ctx.sourcePath);
      let svg = this.svgCache.get(resolved);
      if (!svg) {
        svg = await this.pipe.render(resolved);
        if (this.svgCache.size >= CACHE_LIMIT) {
          this.svgCache.delete(this.svgCache.keys().next().value);
        }
        this.svgCache.set(resolved, svg);
      }
      const svgContent = ((_a = svg.match(/<svg[\s\S]*<\/svg>/i)) != null ? _a : [svg])[0];
      const vb = svgContent.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
      const W = vb ? parseFloat(vb[1]) : parseFloat((_c = (_b = svgContent.match(/\bwidth="([\d.]+)"/)) == null ? void 0 : _b[1]) != null ? _c : "800");
      const H = vb ? parseFloat(vb[2]) : parseFloat((_e = (_d = svgContent.match(/\bheight="([\d.]+)"/)) == null ? void 0 : _d[1]) != null ? _e : "600");
      const container = el.createDiv({ cls: "plantuml-container" });
      container.innerHTML = svgContent;
      const svgEl = container.querySelector("svg");
      if (svgEl) {
        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");
        this.makeZoomable(container, svgEl, W, H);
      }
    } catch (err) {
      el.createEl("pre", {
        text: `PlantUML error: ${err instanceof Error ? err.message : String(err)}`,
        cls: "plantuml-error"
      });
    }
  }
  makeZoomable(container, target, W, H) {
    target.style.position = "absolute";
    target.style.top = "0";
    target.style.left = "0";
    target.style.display = "block";
    target.style.willChange = "transform";
    Object.assign(container.style, {
      overflow: "hidden",
      cursor: "grab",
      position: "relative"
    });
    const handle = container.createDiv();
    Object.assign(handle.style, {
      position: "absolute",
      bottom: "0",
      left: "0",
      right: "0",
      height: "6px",
      cursor: "ns-resize",
      zIndex: "10"
    });
    let resizing = false, resizeStartY = 0, resizeStartH = 0;
    handle.addEventListener("pointerdown", (e) => {
      resizing = true;
      resizeStartY = e.clientY;
      resizeStartH = container.clientHeight;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      container.style.height = `${Math.max(80, resizeStartH + (e.clientY - resizeStartY))}px`;
    });
    handle.addEventListener("pointerup", () => {
      resizing = false;
    });
    container.title = "Cmd+Scroll to zoom \xB7 Drag to pan \xB7 Double-click to reset";
    let scale = 1, tx = 0, ty = 0, minScale = 0.05;
    const clamp = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      tx = Math.min(0, Math.max(tx, cw - W * scale));
      ty = Math.min(0, Math.max(ty, ch - H * scale));
    };
    const applyTranslate = () => {
      target.style.transform = `translate3d(${tx}px,${ty}px,0)`;
    };
    let zoomRafPending = false;
    const applyZoom = () => {
      clamp();
      target.style.width = `${W * scale}px`;
      target.style.height = `${H * scale}px`;
      applyTranslate();
    };
    const scheduleZoom = () => {
      if (zoomRafPending) return;
      zoomRafPending = true;
      requestAnimationFrame(() => {
        zoomRafPending = false;
        applyZoom();
      });
    };
    requestAnimationFrame(() => {
      const cw = container.clientWidth || W;
      scale = Math.min(1, cw / W);
      minScale = scale;
      const maxH = window.innerHeight * 0.6;
      container.style.height = `${Math.min(H * scale, maxH)}px`;
      applyZoom();
    });
    container.addEventListener("wheel", (e) => {
      if (!e.metaKey) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(minScale, Math.min(20, scale * factor));
      tx = mx - (mx - tx) * (newScale / scale);
      ty = my - (my - ty) * (newScale / scale);
      scale = newScale;
      scheduleZoom();
    }, { passive: false });
    let dragging = false, dragX = 0, dragY = 0, startTx = 0, startTy = 0;
    container.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      dragX = e.clientX;
      dragY = e.clientY;
      startTx = tx;
      startTy = ty;
      container.setPointerCapture(e.pointerId);
      container.style.cursor = "grabbing";
    });
    container.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      tx = startTx + (e.clientX - dragX);
      ty = startTy + (e.clientY - dragY);
      clamp();
      applyTranslate();
    });
    container.addEventListener("pointerup", () => {
      dragging = false;
      container.style.cursor = "grab";
    });
    container.addEventListener("dblclick", () => {
      scale = minScale;
      tx = 0;
      ty = 0;
      applyZoom();
    });
  }
  resolveIncludes(source, filePath) {
    return this.resolve(source, filePath, { ancestors: /* @__PURE__ */ new Set(), depth: 0, unconditional: /* @__PURE__ */ new Set() });
  }
  async resolve(source, filePath, state) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian.FileSystemAdapter)) {
      throw new Error("Local PlantUML includes require a desktop vault");
    }
    const lines = source.split("\n");
    const out = [];
    let depth = state.depth;
    for (const line of lines) {
      if (OPENS.test(line)) depth++;
      else if (CLOSES.test(line)) depth = Math.max(state.depth, depth - 1);
      const m = line.match(/^\s*!include(?:_once)?\s+(.+)$/);
      if (m) {
        if (/^<[^<>]+>$/.test(m[1].trim())) {
          out.push(line);
          continue;
        }
        const vaultRel = (0, import_obsidian.normalizePath)(await resolveVaultInclude(
          adapter.getBasePath(),
          filePath,
          m[1].trim()
        ));
        if (state.ancestors.has(vaultRel) || state.unconditional.has(vaultRel)) continue;
        const content = await adapter.read(vaultRel);
        const nested = await this.resolve(unwrap(content), vaultRel, {
          ...state,
          ancestors: /* @__PURE__ */ new Set([...state.ancestors, vaultRel]),
          depth
        });
        if (depth === 0) state.unconditional.add(vaultRel);
        out.push(guard(vaultRel, nested));
        continue;
      }
      out.push(line);
    }
    return out.join("\n");
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.startPipe();
  }
};
var SettingsTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "PlantUML" });
    new import_obsidian.Setting(containerEl).setName("Native PlantUML path").setDesc("Absolute path to a native PlantUML executable. When set, no Java is needed and the JAR and Java paths are ignored.").addText(
      (text) => text.setPlaceholder("/path/to/plantuml").setValue(this.plugin.settings.nativePath).onChange(async (value) => {
        this.plugin.settings.nativePath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("PlantUML JAR path").setDesc("Absolute path to plantuml.jar.").addText(
      (text) => text.setPlaceholder("/path/to/plantuml.jar").setValue(this.plugin.settings.jarPath).onChange(async (value) => {
        this.plugin.settings.jarPath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Java path").setDesc("Path to the java executable.").addText(
      (text) => text.setPlaceholder("/usr/bin/java").setValue(this.plugin.settings.javaPath).onChange(async (value) => {
        this.plugin.settings.javaPath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Graphviz dot path").setDesc("Absolute path to the dot executable.").addText(
      (text) => text.setPlaceholder("/opt/homebrew/bin/dot").setValue(this.plugin.settings.dotPath).onChange(async (value) => {
        this.plugin.settings.dotPath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Layout engine").setDesc("Smetana is PlantUML's built-in layout: no Graphviz needed and faster rendering, but layouts can differ.").addDropdown(
      (dropdown) => dropdown.addOption("graphviz", "Graphviz").addOption("smetana", "Smetana").setValue(this.plugin.settings.layoutEngine).onChange(async (value) => {
        this.plugin.settings.layoutEngine = value;
        await this.plugin.saveSettings();
      })
    );
  }
};
