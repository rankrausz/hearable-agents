// packages/core/src/classify/text.ts — tiny deterministic text helpers the
// classifier uses everywhere: UTF-8 byte encoding, whitespace collapsing and
// token splitting, and path basename extraction. Everything here must produce
// identical output in Node and the browser, so it avoids globals and Node
// built-ins entirely. What it must not do: interpret command grammar or
// classify anything; it only reshapes strings.

export function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      const offset = codePoint - 0x10000;
      bytes.push(
        0xf0 | (offset >> 18),
        0x80 | ((offset >> 12) & 0x3f),
        0x80 | ((offset >> 6) & 0x3f),
        0x80 | (offset & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

export function splitTokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

export function collapseWhitespace(text: string): string {
  return text.trim().split(/\s+/).join(" ");
}

export function pathBasename(path: string): string {
  return path.replace(/^.*[/\\]/, "");
}
