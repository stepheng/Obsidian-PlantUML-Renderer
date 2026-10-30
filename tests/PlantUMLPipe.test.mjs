import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
    entryPoints: ['src/PlantUMLPipe.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
});
const context = vm.createContext({ module: { exports: {} }, require });
vm.runInContext(outputFiles[0].text, context);
const { PlantUMLPipe } = context.module.exports;

// Stands in for PlantUML -pipe: answers each @end line with one SVG holding its
// own arguments and the block it read, and emits nothing for an unterminated block.
const FAKE = `#!/usr/bin/env node
let buf = '', block = [];
process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        block.push(line);
        if (/^@end/.test(line)) {
            process.stdout.write('<svg>' + JSON.stringify({ args: process.argv.slice(2), block: block.join('\\n') }) + '</svg>');
            block = [];
        }
    }
});
`;

let dir, fake;
before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'obsidian-pipe-'));
    fake = path.join(dir, 'plantuml');
    await writeFile(fake, FAKE);
    await chmod(fake, 0o755);
});
after(() => rm(dir, { recursive: true }));

const reply = svg => JSON.parse(svg.slice('<svg>'.length, -'</svg>'.length));

async function render(pipe, source) {
    try { return reply(await pipe.render(source)); } finally { pipe.kill(); }
}

test('runs a native binary directly, without java -jar', async () => {
    const { args } = await render(new PlantUMLPipe('/no/java', '/p/plantuml.jar', '/usr/bin/dot', fake), '@startuml\nA -> B\n@enduml');
    assert.deepEqual(args, ['-Dfile.encoding=UTF-8', '-DPLANTUML_SECURITY_PROFILE=SANDBOX', '-tsvg', '-pipe', '-graphvizdot', '/usr/bin/dot']);
});

test('still runs the JAR through java when no native binary is set', async () => {
    const { args } = await render(new PlantUMLPipe(fake, '/p/plantuml.jar', ''), '@startuml\nA -> B\n@enduml');
    assert.deepEqual(args, ['-Dfile.encoding=UTF-8', '-DPLANTUML_SECURITY_PROFILE=SANDBOX', '-jar', '/p/plantuml.jar', '-tsvg', '-pipe']);
});

test('selects Smetana layout instead of Graphviz', async () => {
    const { args } = await render(new PlantUMLPipe('', '', '/usr/bin/dot', fake, 'smetana'), '@startuml\nA -> B\n@enduml');
    assert.ok(args.includes('-Playout=smetana'));
    assert.ok(!args.includes('-graphvizdot'));
});

test('wraps a bare source in @startuml/@enduml', async () => {
    assert.equal((await render(new PlantUMLPipe('', '', '', fake), 'A -> B')).block, '@startuml\nA -> B\n@enduml');
});

test('terminates a block with no end line instead of stalling', async () => {
    assert.equal((await render(new PlantUMLPipe('', '', '', fake), '@startmindmap\n* root')).block, '@startmindmap\n* root\n@endmindmap');
});

test('sends only the first diagram, so later renders get their own SVG', async () => {
    const pipe = new PlantUMLPipe('', '', '', fake);
    try {
        const first = pipe.render('@startuml\nA -> B\n@enduml\n@startuml\nC -> D\n@enduml');
        const second = pipe.render('@startuml\nE -> F\n@enduml');
        assert.equal(reply(await first).block, '@startuml\nA -> B\n@enduml');
        assert.equal(reply(await second).block, '@startuml\nE -> F\n@enduml');
    } finally { pipe.kill(); }
});
