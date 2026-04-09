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
  default: () => PlantUMLServerPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_child_process = require("child_process");
var import_fs = require("fs");
var nodePath = __toESM(require("path"));
var DEFAULT_SETTINGS = {
  jarPath: "",
  javaPath: "/usr/bin/java",
  dotPath: "/opt/homebrew/bin/dot"
};
var PlantUMLServerPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerMarkdownCodeBlockProcessor("plantuml", (source, el, ctx) => {
      return this.render(source, el, ctx);
    });
    this.addSettingTab(new SettingsTab(this.app, this));
  }
  async render(source, el, ctx) {
    try {
      if (!this.settings.jarPath) throw new Error("JAR path not configured \u2014 set it in plugin settings.");
      const adapter = this.app.vault.adapter;
      const markdownDir = nodePath.join(adapter.getBasePath(), nodePath.dirname(ctx.sourcePath));
      const tmpBase = nodePath.join(markdownDir, `.plantuml-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      const tmpPuml = `${tmpBase}.puml`;
      const tmpSvg = `${tmpBase}.svg`;
      await import_fs.promises.writeFile(tmpPuml, source, "utf-8");
      try {
        await new Promise((resolve, reject) => {
          const args = ["-Dfile.encoding=UTF-8", "-jar", this.settings.jarPath, "-tsvg", tmpPuml];
          if (this.settings.dotPath) args.push("-graphvizdot", this.settings.dotPath);
          const proc = (0, import_child_process.spawn)(this.settings.javaPath, args);
          proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`PlantUML exited with code ${code}`)));
          proc.on("error", reject);
        });
        const svg = await import_fs.promises.readFile(tmpSvg, "utf-8");
        const container = el.createDiv({ cls: "plantuml-container" });
        const svgMatch = svg.match(/<svg[\s\S]*<\/svg>/i);
        container.innerHTML = svgMatch ? svgMatch[0] : svg;
        if (svg.includes("Syntax Error?")) {
          const svgStart = svg.indexOf("<svg");
          const errorText = (svgStart > 0 ? svg.slice(0, svgStart).trim() : "") || [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).filter((t) => t.trim()).join("\n");
          if (errorText) {
            container.createEl("pre", { text: errorText.replace(/↵/g, "\n"), cls: "plantuml-error-text" });
          }
        }
      } finally {
        await Promise.allSettled([import_fs.promises.unlink(tmpPuml), import_fs.promises.unlink(tmpSvg)]);
      }
    } catch (err) {
      el.createEl("pre", {
        text: `PlantUML error: ${err instanceof Error ? err.message : String(err)}`,
        cls: "plantuml-error"
      });
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
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
