/**
 * Locates the first `@start<type>` … `@end<type>` block, the one PlantUML renders
 * (and the one `!include` takes from a wrapped file). `end` is -1 when unterminated.
 */
export function firstBlock(lines: string[]): { type: string; start: number; end: number } | null {
    const start = lines.findIndex(l => /^\s*@start\w+/i.test(l));
    if (start < 0) return null;
    const type = lines[start].match(/@start(\w+)/i)![1];
    const endLine = new RegExp(`^\\s*@end${type}\\s*$`, 'i');
    const end = lines.findIndex((l, i) => i > start && endLine.test(l));
    return { type, start, end };
}
