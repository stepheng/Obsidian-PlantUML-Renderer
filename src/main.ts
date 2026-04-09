import {
    App,
    FileSystemAdapter,
    Plugin,
    PluginSettingTab,
    Setting,
    type MarkdownPostProcessorContext,
} from 'obsidian';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as nodePath from 'path';

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
// Plugin
// ---------------------------------------------------------------------------

export default class PlantUMLServerPlugin extends Plugin {
    settings: Settings;

    async onload() {
        await this.loadSettings();
        this.registerMarkdownCodeBlockProcessor('plantuml', (source, el, ctx) => {
            return this.render(source, el, ctx);
        });
        this.addSettingTab(new SettingsTab(this.app, this));
    }

    private async render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        try {
            if (!this.settings.jarPath) throw new Error('JAR path not configured — set it in plugin settings.');

            const adapter = this.app.vault.adapter as FileSystemAdapter;
            const markdownDir = nodePath.join(adapter.getBasePath(), nodePath.dirname(ctx.sourcePath));
            const tmpBase = nodePath.join(markdownDir, `.plantuml-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
            const tmpPuml = `${tmpBase}.puml`;
            const tmpSvg = `${tmpBase}.svg`;

            await fs.writeFile(tmpPuml, source, 'utf-8');

            try {
                await new Promise<void>((resolve, reject) => {
                    const args = ['-Dfile.encoding=UTF-8', '-jar', this.settings.jarPath, '-tsvg', tmpPuml];
                    if (this.settings.dotPath) args.push('-graphvizdot', this.settings.dotPath);
                    const proc = spawn(this.settings.javaPath, args);
                    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`PlantUML exited with code ${code}`)));
                    proc.on('error', reject);
                });

                const svg = await fs.readFile(tmpSvg, 'utf-8');
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
            } finally {
                await Promise.allSettled([fs.unlink(tmpPuml), fs.unlink(tmpSvg)]);
            }
        } catch (err) {
            el.createEl('pre', {
                text: `PlantUML error: ${err instanceof Error ? err.message : String(err)}`,
                cls: 'plantuml-error',
            });
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

class SettingsTab extends PluginSettingTab {
    plugin: PlantUMLServerPlugin;

    constructor(app: App, plugin: PlantUMLServerPlugin) {
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
