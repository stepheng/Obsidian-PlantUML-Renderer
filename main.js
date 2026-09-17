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
var import_child_process = require("child_process");

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

// src/main.ts
var DEFAULT_SETTINGS = {
  jarPath: "",
  javaPath: "/usr/bin/java",
  dotPath: "/opt/homebrew/bin/dot"
};
var PlantUMLPipe = class {
  constructor(javaPath, jarPath, dotPath) {
    this.javaPath = javaPath;
    this.jarPath = jarPath;
    this.dotPath = dotPath;
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
      const wrapped = /^\s*@startuml/i.test(item.source) ? item.source : `@startuml
${item.source}
@enduml`;
      this.proc.stdin.write(wrapped + "\n");
    } catch (err) {
      this.pending = null;
      item.reject(err instanceof Error ? err : new Error(String(err)));
      this.next();
    }
  }
  ensureRunning() {
    if (this.proc && !this.proc.killed) return;
    const args = ["-Dfile.encoding=UTF-8", "-DPLANTUML_SECURITY_PROFILE=SANDBOX", "-jar", this.jarPath, "-tsvg", "-pipe"];
    if (this.dotPath) args.push("-graphvizdot", this.dotPath);
    this.proc = (0, import_child_process.spawn)(this.javaPath, args);
    this.outBuf = "";
    this.proc.stdout.on("data", (chunk) => {
      this.outBuf += chunk.toString("utf-8");
      const end = this.outBuf.indexOf("</svg>");
      if (end === -1) return;
      const svg = this.outBuf.slice(0, end + 6);
      this.outBuf = this.outBuf.slice(end + 6);
      const p = this.pending;
      this.pending = null;
      p.resolve(svg);
      this.next();
    });
    this.proc.stderr.on("data", () => {
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
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.reject(new Error(`PlantUML process exited unexpectedly (code ${code})`));
        if (this.queue.length > 0) this.next();
      }
    });
  }
};
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
    this.pipe = this.settings.jarPath ? new PlantUMLPipe(this.settings.javaPath, this.settings.jarPath, this.settings.dotPath) : null;
  }
  async render(source, el, ctx) {
    var _a, _b, _c, _d, _e;
    try {
      if (!this.pipe) throw new Error("JAR path not configured \u2014 set it in plugin settings.");
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
  async resolveIncludes(source, filePath, seen = /* @__PURE__ */ new Set()) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian.FileSystemAdapter)) {
      throw new Error("Local PlantUML includes require a desktop vault");
    }
    const lines = source.split("\n");
    const out = [];
    for (const line of lines) {
      const m = line.match(/^\s*!include\s+(.+)$/);
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
        if (seen.has(vaultRel)) continue;
        const content = await adapter.read(vaultRel);
        seen.add(vaultRel);
        out.push(await this.resolveIncludes(content, vaultRel, seen));
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
  }
};
