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

const GUARD_LINE = /^!(if %not\(%variable_exists\("\$__include_\w+"\)\)|global \$__include_\w+ = %true\(\)|endif)$/;
const body = s => s.split('\n').filter(l => !GUARD_LINE.test(l)).join('\n');

async function resolveIn(files, source, note = 'page.md') {
    const vault = await mkdtemp(path.join(tmpdir(), 'obsidian-includes-'));
    try {
        for (const [name, content] of Object.entries(files)) await writeFile(path.join(vault, name), content);
        const plugin = new context.module.exports.default();
        plugin.app = { vault: { adapter: new FileSystemAdapter(vault) } };
        return await plugin.resolveIncludes(source, note);
    } finally { await rm(vault, { recursive: true }); }
}

test('preserves bundled-library includes alongside nested local includes', async () => {
    const vault = await mkdtemp(path.join(tmpdir(), 'obsidian-includes-'));
    try {
        await mkdir(path.join(vault, 'notes'));
        await writeFile(path.join(vault, 'shared.iuml'), '!include <archimate/Archimate>\nAlice -> Bob');
        const plugin = new context.module.exports.default();
        plugin.app = { vault: { adapter: new FileSystemAdapter(vault) } };
        const source = '  !include <C4/C4_Context>  \n!include ../shared.iuml';
        assert.equal(body(await plugin.resolveIncludes(source, 'notes/page.md')),
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

test('inlines only the first block body of an included file wrapped in @startuml/@enduml', async () => {
    const out = await resolveIn({ 'a.iuml': '@startuml\nA -> B\n@enduml\n@startuml\nC -> D\n@enduml' }, '@startuml\n!include a.iuml\nX -> Y\n@enduml');
    assert.equal(body(out), '@startuml\nA -> B\nX -> Y\n@enduml');
});

test('wraps each inlined file in a guard so PlantUML skips repeats itself', async () => {
    const out = await resolveIn({ 'a.iuml': 'A -> B' }, '!include a.iuml');
    assert.match(out, /^!if %not\(%variable_exists\("\$__include_\w+"\)\)\n!global \$__include_\w+ = %true\(\)\nA -> B\n!endif$/);
});

test('inlines a file included in two !if branches into both', async () => {
    const out = await resolveIn({ 'a.iuml': 'A -> B' }, '!if $x\n!include a.iuml\n!else\n!include a.iuml\n!endif');
    assert.equal(body(out).match(/A -> B/g).length, 2);
});

test('does not repeat a file already inlined unconditionally', async () => {
    const out = await resolveIn({ 'a.iuml': 'A -> B' }, '!include a.iuml\n!include_once a.iuml');
    assert.equal(body(out), 'A -> B');
});

test('stops at circular includes', async () => {
    const out = await resolveIn({ 'a.iuml': 'A\n!include b.iuml', 'b.iuml': 'B\n!include a.iuml' }, '!include a.iuml');
    assert.equal(body(out), 'A\nB');
});
