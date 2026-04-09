import {
    App,
    normalizePath,
    Plugin,
    PluginSettingTab,
    Setting,
    type MarkdownPostProcessorContext,
} from 'obsidian';
import { spawn, type ChildProcess } from 'child_process';

interface Settings {
    jarPath: string;
    javaPath: string;
    dotPath: string;
}

const DEFAULT_SETTINGS: Settings = {
    jarPath: '',
    javaPath: '/usr/bin/java',
    dotPath: '/opt/homebrew/bin/dot',
};

// ---------------------------------------------------------------------------
// Persistent PlantUML pipe process
// One JVM per plugin lifetime. Diagrams are serialised through a queue.
// ---------------------------------------------------------------------------

class PlantUMLPipe {
    private proc: ChildProcess | null = null;
    private outBuf = '';
    private pending: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
    private queue: Array<{ source: string; resolve: (s: string) => void; reject: (e: Error) => void }> = [];

    constructor(
        private javaPath: string,
        private jarPath: string,
        private dotPath: string,
    ) {}

    render(source: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.queue.push({ source, resolve, reject });
            if (!this.pending) this.next();
        });
    }

    kill() {
        this.proc?.kill();
        this.proc = null;
        const err = new Error('PlantUML pipe closed');
        this.pending?.reject(err);
        this.pending = null;
        this.queue.forEach(item => item.reject(err));
        this.queue = [];
    }

    private next() {
        if (this.queue.length === 0) return;
        const item = this.queue.shift()!;
        this.pending = item;
        try {
            this.ensureRunning();
            const wrapped = /^\s*@startuml/i.test(item.source)
                ? item.source
                : `@startuml\n${item.source}\n@enduml`;
            this.proc!.stdin!.write(wrapped + '\n');
        } catch (err) {
            this.pending = null;
            item.reject(err instanceof Error ? err : new Error(String(err)));
            this.next();
        }
    }

    private ensureRunning() {
        if (this.proc && !this.proc.killed) return;

        const args = ['-Dfile.encoding=UTF-8', '-jar', this.jarPath, '-tsvg', '-pipe'];
        if (this.dotPath) args.push('-graphvizdot', this.dotPath);

        this.proc = spawn(this.javaPath, args);
        this.outBuf = '';

        this.proc.stdout!.on('data', (chunk: Buffer) => {
            this.outBuf += chunk.toString('utf-8');
            const end = this.outBuf.indexOf('</svg>');
            if (end === -1) return;
            const svg = this.outBuf.slice(0, end + 6);
            this.outBuf = this.outBuf.slice(end + 6);
            const p = this.pending!;
            this.pending = null;
            p.resolve(svg);
            this.next();
        });

        this.proc.stderr!.on('data', () => {});

        this.proc.on('error', (err) => {
            const p = this.pending;
            this.pending = null;
            this.proc = null;
            p?.reject(err);
            this.queue.forEach(item => item.reject(err));
            this.queue = [];
        });

        this.proc.on('close', (code) => {
            this.proc = null;
            if (this.pending) {
                const p = this.pending;
                this.pending = null;
                p.reject(new Error(`PlantUML process exited unexpectedly (code ${code})`));
                if (this.queue.length > 0) this.next();
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class PlantUMLRendererPlugin extends Plugin {
    settings: Settings;
    private pipe: PlantUMLPipe | null = null;

    async onload() {
        await this.loadSettings();
        this.startPipe();
        this.registerMarkdownCodeBlockProcessor('plantuml', (source, el, ctx) => {
            return this.render(source, el, ctx);
        });
        this.addSettingTab(new SettingsTab(this.app, this));
    }

    onunload() {
        this.pipe?.kill();
    }

    startPipe() {
        this.pipe?.kill();
        this.pipe = this.settings.jarPath
            ? new PlantUMLPipe(this.settings.javaPath, this.settings.jarPath, this.settings.dotPath)
            : null;
    }

    private async render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        try {
            if (!this.pipe) throw new Error('JAR path not configured — set it in plugin settings.');
            const resolved = await this.resolveIncludes(source, ctx.sourcePath);
            const svg = await this.pipe.render(resolved);
            const container = el.createDiv({ cls: 'plantuml-container' });
            const svgMatch = svg.match(/<svg[\s\S]*<\/svg>/i);
            container.innerHTML = svgMatch ? svgMatch[0] : svg;

            if (svg.includes('Syntax Error?')) {
                const svgStart = svg.indexOf('<svg');
                const errorText = (svgStart > 0 ? svg.slice(0, svgStart).trim() : '')
                    || [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)]
                        .map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
                        .filter(t => t.trim())
                        .join('\n');
                if (errorText) {
                    container.createEl('pre', { text: errorText.replace(/↵/g, '\n'), cls: 'plantuml-error-text' });
                }
            }
        } catch (err) {
            el.createEl('pre', {
                text: `PlantUML error: ${err instanceof Error ? err.message : String(err)}`,
                cls: 'plantuml-error',
            });
        }
    }

    private async resolveIncludes(source: string, filePath: string, seen = new Set<string>()): Promise<string> {
        const adapter = this.app.vault.adapter;
        const dir = filePath.contains('/')
            ? filePath.substring(0, filePath.lastIndexOf('/'))
            : '';
        const lines = source.split('\n');
        const out: string[] = [];
        for (const line of lines) {
            const m = line.match(/^\s*!include\s+(.+)$/);
            if (m) {
                const vaultRel = normalizePath(joinPath(dir, m[1].trim()));
                if (seen.has(vaultRel)) continue;
                try {
                    const content = await adapter.read(vaultRel);
                    seen.add(vaultRel);
                    out.push(await this.resolveIncludes(content, vaultRel, seen));
                    continue;
                } catch {
                    // Not found in vault — pass through to JAR
                }
            }
            out.push(line);
        }
        return out.join('\n');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.startPipe();
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function joinPath(dir: string, rel: string): string {
    const parts = dir ? dir.split('/') : [];
    for (const seg of rel.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

class SettingsTab extends PluginSettingTab {
    plugin: PlantUMLRendererPlugin;

    constructor(app: App, plugin: PlantUMLRendererPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'PlantUML' });

        new Setting(containerEl)
            .setName('PlantUML JAR path')
            .setDesc('Absolute path to plantuml.jar.')
            .addText(text =>
                text
                    .setPlaceholder('/path/to/plantuml.jar')
                    .setValue(this.plugin.settings.jarPath)
                    .onChange(async (value) => {
                        this.plugin.settings.jarPath = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Java path')
            .setDesc('Path to the java executable.')
            .addText(text =>
                text
                    .setPlaceholder('/usr/bin/java')
                    .setValue(this.plugin.settings.javaPath)
                    .onChange(async (value) => {
                        this.plugin.settings.javaPath = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Graphviz dot path')
            .setDesc('Absolute path to the dot executable.')
            .addText(text =>
                text
                    .setPlaceholder('/opt/homebrew/bin/dot')
                    .setValue(this.plugin.settings.dotPath)
                    .onChange(async (value) => {
                        this.plugin.settings.dotPath = value.trim();
                        await this.plugin.saveSettings();
                    })
            );
    }
}
