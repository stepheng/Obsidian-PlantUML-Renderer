import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveVaultInclude } from '../src/IncludePaths.ts';

test('allows an include inside the vault, including a parent directory', async () => {
    const vault = await mkdtemp(path.join(tmpdir(), 'obsidian-puml-'));
    try {
        await mkdir(path.join(vault, 'notes'));
        await writeFile(path.join(vault, 'shared.iuml'), 'shared');
        assert.equal(await resolveVaultInclude(vault, 'notes/page.md', '../shared.iuml'), 'shared.iuml');
    } finally { await rm(vault, { recursive: true }); }
});

test('rejects parent traversal and absolute includes outside the vault', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obsidian-puml-'));
    const vault = path.join(root, 'vault');
    try {
        await mkdir(vault);
        await writeFile(path.join(root, 'outside.iuml'), 'private marker');
        await assert.rejects(resolveVaultInclude(vault, 'page.md', '../outside.iuml'), /outside vault/);
        await assert.rejects(resolveVaultInclude(vault, 'page.md', path.join(root, 'outside.iuml')), /outside vault/);
    } finally { await rm(root, { recursive: true }); }
});

test('rejects a symlink escaping the vault', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obsidian-puml-'));
    const vault = path.join(root, 'vault');
    try {
        await mkdir(vault);
        await writeFile(path.join(root, 'outside.iuml'), 'private marker');
        await symlink(path.join(root, 'outside.iuml'), path.join(vault, 'link.iuml'));
        await assert.rejects(resolveVaultInclude(vault, 'page.md', 'link.iuml'), /outside vault/);
    } finally { await rm(root, { recursive: true }); }
});
