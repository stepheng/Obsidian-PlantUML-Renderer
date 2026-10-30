import {
    App,
    FileSystemAdapter,
    normalizePath,
    Plugin,
    PluginSettingTab,
    Setting,
    type MarkdownPostProcessorContext,
} from 'obsidian';
import { createHash } from 'crypto';
import { firstBlock } from './DiagramBlock';
import { resolveVaultInclude } from './IncludePaths';
import { PlantUMLPipe } from './PlantUMLPipe';

interface Settings {
    nativePath: string;
    jarPath: string;
    javaPath: string;
    dotPath: string;
    layoutEngine: 'graphviz' | 'smetana';
}

const DEFAULT_SETTINGS: Settings = {
    nativePath: '',
    jarPath: '',
    javaPath: '/usr/bin/java',
    dotPath: '/opt/homebrew/bin/dot',
    layoutEngine: 'graphviz',
};

// ---------------------------------------------------------------------------
// Include resolution
// ---------------------------------------------------------------------------

// PlantUML includes each file once, but only where an !include is actually reached
// (a file can sit in several !if branches). Deduplicating here, before !if is
// evaluated, would drop it from whichever branch is active, so each inlined copy
// carries a preprocessor guard and PlantUML skips the repeats itself.
function guard(vaultPath: string, content: string): string {
    const id = `$__include_${createHash('sha1').update(vaultPath).digest('hex').slice(0, 12)}`;
    return `!if %not(%variable_exists("${id}"))\n!global ${id} = %true()\n${content}\n!endif`;
}

// Like PlantUML, take only the first block's body from a file wrapped in @start/@end;
// inlining the wrapper would end the including diagram at the included @end line.
function unwrap(content: string): string {
    const lines = content.split('\n');
    const block = firstBlock(lines);
    if (!block) return content;
    return lines.slice(block.start + 1, block.end < 0 ? undefined : block.end).join('\n');
}

// Lines that open or close a block whose body may run zero or many times.
// A one-line `!function $f() !return …` opens nothing.
const OPENS = /^\s*!(?:if|ifdef|ifndef|while|foreach|procedure|function|unquoted\s+(?:procedure|function))\b(?!.*!return\b)/i;
const CLOSES = /^\s*!(?:endif|endwhile|endfor|endprocedure|endfunction)\b/i;

interface IncludeState {
    ancestors: Set<string>;
    /** Open conditional/loop/procedure blocks enclosing the current line, across all including files */
    depth: number;
    /** Files already inlined outside any such block: PlantUML is certain to skip any later copy */
    unconditional: Set<string>;
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
        const { nativePath, javaPath, jarPath, dotPath, layoutEngine } = this.settings;
        this.pipe = nativePath || jarPath
            ? new PlantUMLPipe(javaPath, jarPath, dotPath, nativePath, layoutEngine)
            : null;
    }

    private async render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        try {
            if (!this.pipe) throw new Error('PlantUML not configured — set the native binary or JAR path in plugin settings.');
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

    private resolveIncludes(source: string, filePath: string): Promise<string> {
        return this.resolve(source, filePath, { ancestors: new Set(), depth: 0, unconditional: new Set() });
    }

    private async resolve(source: string, filePath: string, state: IncludeState): Promise<string> {
        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            throw new Error('Local PlantUML includes require a desktop vault');
        }
        const lines = source.split('\n');
        const out: string[] = [];
        let depth = state.depth;
        for (const line of lines) {
            if (OPENS.test(line)) depth++;
            else if (CLOSES.test(line)) depth = Math.max(state.depth, depth - 1);
            const m = line.match(/^\s*!include(?:_once)?\s+(.+)$/);
            if (m) {
                // Bundled libraries are resolved by the sandboxed JAR, not the vault.
                if (/^<[^<>]+>$/.test(m[1].trim())) {
                    out.push(line);
                    continue;
                }
                const vaultRel = normalizePath(await resolveVaultInclude(
                    adapter.getBasePath(), filePath, m[1].trim()
                ));
                if (state.ancestors.has(vaultRel) || state.unconditional.has(vaultRel)) continue; // cycle, or certain repeat
                const content = await adapter.read(vaultRel);
                const nested = await this.resolve(unwrap(content), vaultRel, {
                    ...state, ancestors: new Set([...state.ancestors, vaultRel]), depth,
                });
                if (depth === 0) state.unconditional.add(vaultRel);
                out.push(guard(vaultRel, nested));
                continue;
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
            .setName('Native PlantUML path')
            .setDesc('Absolute path to a native PlantUML executable. When set, no Java is needed and the JAR and Java paths are ignored.')
            .addText(text =>
                text
                    .setPlaceholder('/path/to/plantuml')
                    .setValue(this.plugin.settings.nativePath)
                    .onChange(async (value) => {
                        this.plugin.settings.nativePath = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

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

        new Setting(containerEl)
            .setName('Layout engine')
            .setDesc('Smetana is PlantUML\'s built-in layout: no Graphviz needed and faster rendering, but layouts can differ.')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('graphviz', 'Graphviz')
                    .addOption('smetana', 'Smetana')
                    .setValue(this.plugin.settings.layoutEngine)
                    .onChange(async (value) => {
                        this.plugin.settings.layoutEngine = value as Settings['layoutEngine'];
                        await this.plugin.saveSettings();
                    })
            );
    }
}
