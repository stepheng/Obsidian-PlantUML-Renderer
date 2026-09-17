import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
    entryPoints: ['src/main.ts'], bundle: true, platform: 'node',
    format: 'cjs', external: ['obsidian'], write: false,
});

// Obsidian supplies these classes at runtime; file reads remain real.
class FileSystemAdapter {
    constructor(root) { this.root = root; }
    getBasePath() { return this.root; }
    read(file) { return readFile(path.join(this.root, file), 'utf8'); }
}
const context = vm.createContext({
    module: { exports: {} },
    require: name => name === 'obsidian'
        ? { Plugin: class {}, PluginSettingTab: class {}, FileSystemAdapter, normalizePath: p => p }
        : require(name),
});
vm.runInContext(outputFiles[0].text, context);

test('preserves bundled-library includes alongside nested local includes', async () => {
    const vault = await mkdtemp(path.join(tmpdir(), 'obsidian-includes-'));
    try {
        await mkdir(path.join(vault, 'notes'));
        await writeFile(path.join(vault, 'shared.iuml'), '!include <archimate/Archimate>\nAlice -> Bob');
        const plugin = new context.module.exports.default();
        plugin.app = { vault: { adapter: new FileSystemAdapter(vault) } };
        const source = '  !include <C4/C4_Context>  \n!include ../shared.iuml';
        assert.equal(await plugin.resolveIncludes(source, 'notes/page.md'),
            '  !include <C4/C4_Context>  \n!include <archimate/Archimate>\nAlice -> Bob');
    } finally { await rm(vault, { recursive: true }); }
});

test('still rejects outside-vault local includes after a bundled-library include', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obsidian-includes-'));
    try {
        const vault = path.join(root, 'vault');
        await mkdir(vault);
        await writeFile(path.join(root, 'outside.iuml'), 'private marker');
        const plugin = new context.module.exports.default();
        plugin.app = { vault: { adapter: new FileSystemAdapter(vault) } };
        await assert.rejects(plugin.resolveIncludes(
            '!include <archimate/Archimate>\n!include ../outside.iuml', 'page.md'), /outside vault/);
    } finally { await rm(root, { recursive: true }); }
});
