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

const CACHE_LIMIT = 30;

export default class PlantUMLRendererPlugin extends Plugin {
    settings: Settings;
    private pipe: PlantUMLPipe | null = null;
    private svgCache = new Map<string, string>();

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
        this.svgCache.clear();
        this.pipe = this.settings.jarPath
            ? new PlantUMLPipe(this.settings.javaPath, this.settings.jarPath, this.settings.dotPath)
            : null;
    }

    private async render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        try {
            if (!this.pipe) throw new Error('JAR path not configured — set it in plugin settings.');
            const resolved = await this.resolveIncludes(source, ctx.sourcePath);
            let svg = this.svgCache.get(resolved);
            if (!svg) {
                svg = await this.pipe.render(resolved);
                if (this.svgCache.size >= CACHE_LIMIT) {
                    this.svgCache.delete(this.svgCache.keys().next().value!);
                }
                this.svgCache.set(resolved, svg);
            }
            const svgContent = (svg.match(/<svg[\s\S]*<\/svg>/i) ?? [svg])[0];

            // Use viewBox as the authoritative content dimensions — width/height attributes
            // are in pt (e.g. "504pt"), which has a different px equivalent to the SVG user units.
            const vb = svgContent.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
            const W = vb ? parseFloat(vb[1]) : parseFloat(svgContent.match(/\bwidth="([\d.]+)"/)?.[1] ?? '800');
            const H = vb ? parseFloat(vb[2]) : parseFloat(svgContent.match(/\bheight="([\d.]+)"/)?.[1] ?? '600');

            const container = el.createDiv({ cls: 'plantuml-container' });
            container.innerHTML = svgContent;

            const svgEl = container.querySelector('svg') as HTMLElement | null;
            if (svgEl) {
                svgEl.removeAttribute('width');
                svgEl.removeAttribute('height');
                this.makeZoomable(container, svgEl, W, H);
            }
        } catch (err) {
            el.createEl('pre', {
                text: `PlantUML error: ${err instanceof Error ? err.message : String(err)}`,
                cls: 'plantuml-error',
            });
        }
    }

    private makeZoomable(container: HTMLElement, target: HTMLElement, W: number, H: number) {
        // Absolute positioning takes the SVG out of normal flow so growing its
        // width/height for zoom doesn't affect container layout.
        target.style.position = 'absolute';
        target.style.top = '0';
        target.style.left = '0';
        target.style.display = 'block';
        // willChange for translate — zoom is handled by resizing the element itself
        target.style.willChange = 'transform';

        Object.assign(container.style, {
            overflow: 'hidden',
            cursor: 'grab',
            position: 'relative',
        });

        // Custom resize handle — CSS resize doesn't work with overflow:hidden in Chrome
        const handle = container.createDiv();
        Object.assign(handle.style, {
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            height: '6px',
            cursor: 'ns-resize',
            zIndex: '10',
        });
        let resizing = false, resizeStartY = 0, resizeStartH = 0;
        handle.addEventListener('pointerdown', (e: PointerEvent) => {
            resizing = true;
            resizeStartY = e.clientY;
            resizeStartH = container.clientHeight;
            handle.setPointerCapture(e.pointerId);
            e.stopPropagation();
        });
        handle.addEventListener('pointermove', (e: PointerEvent) => {
            if (!resizing) return;
            container.style.height = `${Math.max(80, resizeStartH + (e.clientY - resizeStartY))}px`;
        });
        handle.addEventListener('pointerup', () => { resizing = false; });
        container.title = 'Cmd+Scroll to zoom · Drag to pan · Double-click to reset';

        let scale = 1, tx = 0, ty = 0, minScale = 0.05;

        const clamp = () => {
            const cw = container.clientWidth;
            const ch = container.clientHeight;
            tx = Math.min(0, Math.max(tx, cw - W * scale));
            ty = Math.min(0, Math.max(ty, ch - H * scale));
        };

        // Pan: translate only — GPU composited, no layout
        const applyTranslate = () => {
            target.style.transform = `translate3d(${tx}px,${ty}px,0)`;
        };

        // Zoom: resize the element so SVG re-rasterises at the correct resolution
        // (translate scale() just enlarges the existing texture — blurry when zoomed in)
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
            requestAnimationFrame(() => { zoomRafPending = false; applyZoom(); });
        };

        // Initial fit-to-width; size container to the scaled diagram height
        requestAnimationFrame(() => {
            const cw = container.clientWidth || W;
            scale = Math.min(1, cw / W);
            minScale = scale;
            const maxH = window.innerHeight * 0.6;
            container.style.height = `${Math.min(H * scale, maxH)}px`;
            applyZoom();
        });

        // Cmd+scroll to zoom toward cursor; plain scroll scrolls the page
        container.addEventListener('wheel', (e: WheelEvent) => {
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

        // Drag to pan — translate only, stays on compositor
        let dragging = false, dragX = 0, dragY = 0, startTx = 0, startTy = 0;

        container.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            dragging = true;
            dragX = e.clientX; dragY = e.clientY;
            startTx = tx; startTy = ty;
            container.setPointerCapture(e.pointerId);
            container.style.cursor = 'grabbing';
        });

        container.addEventListener('pointermove', (e: PointerEvent) => {
            if (!dragging) return;
            tx = startTx + (e.clientX - dragX);
            ty = startTy + (e.clientY - dragY);
            clamp();
            applyTranslate();
        });

        container.addEventListener('pointerup', () => {
            dragging = false;
            container.style.cursor = 'grab';
        });

        // Double-click to reset to initial fit-to-width
        container.addEventListener('dblclick', () => {
            scale = minScale;
            tx = 0; ty = 0;
            applyZoom();
        });
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
