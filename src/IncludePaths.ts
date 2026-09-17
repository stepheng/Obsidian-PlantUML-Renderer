import { realpath } from 'fs/promises';
import * as path from 'path';

export async function resolveVaultInclude(
    vaultPath: string,
    notePath: string,
    includePath: string,
): Promise<string> {
    const root = path.resolve(vaultPath);
    if (path.isAbsolute(includePath)) throw new Error('Include is outside vault');
    const candidate = path.resolve(root, path.dirname(notePath), includePath);
    const inside = (location: string, base: string) => {
        const relative = path.relative(base, location);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    if (!inside(candidate, root)) throw new Error('Include is outside vault');
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!inside(realCandidate, realRoot)) throw new Error('Include is outside vault');
    return path.relative(realRoot, realCandidate).split(path.sep).join('/');
}
