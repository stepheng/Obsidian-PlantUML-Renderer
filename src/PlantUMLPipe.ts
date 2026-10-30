import { spawn, type ChildProcess } from 'child_process';
import { firstBlock } from './DiagramBlock';

interface Pending {
    resolve: (s: string) => void;
    reject: (e: Error) => void;
}

interface QueueItem extends Pending {
    source: string;
}

// Send exactly one terminated diagram per render. In -pipe mode PlantUML emits
// nothing until it reads the matching @end line, so a source without one (e.g.
// mid-edit) would stall every later render; and each extra block in the source
// would emit an extra SVG, pairing every later response with the wrong request.
function terminate(source: string): string {
    const lines = source.split('\n');
    const block = firstBlock(lines);
    if (!block) return `@startuml\n${source}\n@enduml`;
    if (block.end < 0) return [...lines.slice(block.start), `@end${block.type}`].join('\n');
    return lines.slice(block.start, block.end + 1).join('\n');
}

export class PlantUMLPipe {
    private proc: ChildProcess | null = null;
    private outBuf = '';
    private pending: Pending | null = null;
    private queue: QueueItem[] = [];

    constructor(
        private readonly javaPath: string,
        private readonly jarPath: string,
        private readonly dotPath: string,
        private readonly nativePath = '',
        private readonly layout: 'graphviz' | 'smetana' = 'graphviz',
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
            this.proc!.stdin!.write(terminate(item.source) + '\n');
        } catch (err) {
            this.pending = null;
            item.reject(err instanceof Error ? err : new Error(String(err)));
            this.next();
        }
    }

    private ensureRunning() {
        if (this.proc && !this.proc.killed) return;

        // A native (GraalVM) binary takes the same -D flags and runs without java -jar
        const args = ['-Dfile.encoding=UTF-8', '-DPLANTUML_SECURITY_PROFILE=SANDBOX'];
        if (!this.nativePath) args.push('-jar', this.jarPath);
        args.push('-tsvg', '-pipe');
        // Smetana is PlantUML's built-in port of dot: no external process per render
        if (this.layout === 'smetana') args.push('-Playout=smetana');
        else if (this.dotPath) args.push('-graphvizdot', this.dotPath);

        this.proc = spawn(this.nativePath || this.javaPath, args);
        this.outBuf = '';

        this.proc.stdout!.on('data', (chunk: Buffer) => {
            this.outBuf += chunk.toString('utf-8');
            let end: number;
            while ((end = this.outBuf.indexOf('</svg>')) !== -1) {
                const svg = this.outBuf.slice(0, end + 6);
                this.outBuf = this.outBuf.slice(end + 6);
                if (!this.pending) break;
                const p = this.pending;
                this.pending = null;
                p.resolve(svg);
                this.next();
            }
        });

        this.proc.stderr!.on('data', () => {});

        this.proc.stdin!.on('error', (err) => {
            const p = this.pending;
            this.pending = null;
            this.proc = null;
            p?.reject(err);
            this.queue.forEach(item => item.reject(err));
            this.queue = [];
        });

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
            const err = new Error(`PlantUML process exited unexpectedly (code ${code})`);
            if (this.pending) {
                const p = this.pending;
                this.pending = null;
                p.reject(err);
            }
            this.queue.forEach(item => item.reject(err));
            this.queue = [];
        });
    }
}
