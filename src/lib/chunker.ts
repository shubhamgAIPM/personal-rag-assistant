// Token-aware chunker. Pure (no browser/Node APIs) so it runs in a worker and
// in Node tests. The caller supplies a token counter built from the embedding
// model's own tokenizer.
//
// Strategy: split into headings/paragraphs/sentences and greedily pack up to the
// target size. A new chunk always starts at a heading, so a chunk NEVER spans two
// sections and its locator (the heading path, e.g. "Doc > Section") is accurate.
// Within a long section, a small overlap of trailing sentences is carried over.

export type TokenCounter = (text: string) => number;

export interface ChunkOptions {
  /** Pack chunks up to roughly this many tokens. */
  targetTokens: number;
  /** No single unit is allowed to exceed this; oversized units are split. */
  maxTokens: number;
  /** Approximate tokens of trailing context repeated at the start of the next chunk. */
  overlapTokens: number;
  /**
   * Character cap per unit. Needed because the tokenizer maps very long
   * unbroken strings (base64, minified blobs) to a single [UNK] token, so a
   * token limit alone would let them through as one huge chunk.
   */
  maxChars: number;
}

// Model limit is 512 including 2 special tokens; keep generous headroom.
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 350,
  maxTokens: 400,
  overlapTokens: 50,
  maxChars: 2400,
};

export interface Chunk {
  index: number;
  content: string;
  /** Nearest heading at the start of the chunk, or null (e.g. plain text). */
  locator: string | null;
  tokens: number;
}

interface Unit {
  text: string;
  tokens: number;
  heading: string | null;
  isHeading: boolean;
  /** Separator placed before this unit when it is not first in a chunk. */
  sep: string;
}

export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Intentionally strips NUL characters.
    // oxlint-disable-next-line no-control-regex
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9"'([])/;

function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Split text that is too large for one chunk, by whitespace (or hard split if none). */
function splitOversized(text: string, count: TokenCounter, opts: ChunkOptions): string[] {
  const total = count(text);
  if (total <= opts.maxTokens && text.length <= opts.maxChars) return [text];

  const ratio = total / Math.max(text.length, 1); // tokens per char
  const approxChars = Math.min(
    Math.max(Math.floor(opts.targetTokens / Math.max(ratio, 1e-6)), 20),
    opts.maxChars,
  );

  const pieces: string[] = [];
  let rest = text;
  while (rest.length > approxChars) {
    let cut = rest.lastIndexOf(" ", approxChars);
    if (cut < approxChars * 0.5) cut = approxChars; // no sensible space: hard split
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);

  // Re-check: halve any piece that is still too large (rare, e.g. dense symbols).
  return pieces.flatMap((p) =>
    (count(p) > opts.maxTokens || p.length > opts.maxChars) && p.length > 40
      ? splitOversized(p.slice(0, Math.floor(p.length / 2)), count, opts).concat(
          splitOversized(p.slice(Math.floor(p.length / 2)), count, opts),
        )
      : [p],
  );
}

function buildUnits(text: string, count: TokenCounter, opts: ChunkOptions): Unit[] {
  const units: Unit[] = [];
  // Heading stack, so the locator is a path like "Doc title > Section > Subsection".
  const stack: { level: number; text: string }[] = [];
  let heading: string | null = null;
  let inFence = false;

  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const fenceCount = (trimmed.match(/^```/gm) ?? []).length;
    const startsInFence = inFence;
    if (fenceCount % 2 === 1) inFence = !inFence;

    const headingMatch = !startsInFence && !trimmed.includes("\n") && /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: headingMatch[2].trim() });
      heading = stack.map((h) => h.text).join(" > ");
      units.push({ text: trimmed, tokens: count(trimmed), heading, isHeading: true, sep: "\n\n" });
      continue;
    }

    // Code fences and lists stay as one block (sentence splitting would mangle them);
    // oversized blocks are split below.
    const isStructured = startsInFence || fenceCount > 0 || /^\s*([-*+]|\d+\.)\s/m.test(trimmed);
    const parts = isStructured ? [trimmed] : splitSentences(trimmed);

    parts.forEach((part, i) => {
      for (const piece of splitOversized(part, count, opts)) {
        units.push({
          text: piece,
          tokens: count(piece),
          heading,
          isHeading: false,
          sep: i === 0 ? "\n\n" : " ",
        });
      }
    });
  }
  return units;
}

function assemble(units: Unit[]): string {
  return units.map((u, i) => (i === 0 ? u.text : u.sep + u.text)).join("");
}

export function chunkText(
  rawText: string,
  count: TokenCounter,
  options: Partial<ChunkOptions> = {},
): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (opts.overlapTokens >= opts.targetTokens) {
    throw new Error("overlapTokens must be smaller than targetTokens");
  }
  if (opts.targetTokens > opts.maxTokens) {
    throw new Error("targetTokens must not exceed maxTokens");
  }

  const text = normalizeText(rawText);
  if (!text) return [];

  const units = buildUnits(text, count, opts);
  const chunks: Chunk[] = [];

  let current: Unit[] = [];
  let currentTokens = 0;
  let freshFrom = 0; // index in `current` where non-overlap content starts

  const emit = () => {
    // Don't leave a heading dangling at the end of a chunk; carry it forward.
    let carry: Unit | null = null;
    if (current.length > 1 && current[current.length - 1].isHeading) {
      carry = current.pop() as Unit;
    }
    const content = assemble(current);
    if (content.trim()) {
      const first = current[Math.min(freshFrom, current.length - 1)];
      chunks.push({
        index: chunks.length,
        content,
        locator: first?.heading ?? null,
        tokens: count(content),
      });
    }

    // Overlap: trailing units totalling <= overlapTokens.
    const overlap: Unit[] = [];
    let sum = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i].isHeading) break;
      if (sum + current[i].tokens > opts.overlapTokens) break;
      overlap.unshift(current[i]);
      sum += current[i].tokens;
    }
    current = carry ? [...overlap, carry] : overlap;
    currentTokens = current.reduce((n, u) => n + u.tokens, 0);
    freshFrom = overlap.length; // first genuinely new unit comes after the overlap
  };

  const charsOf = (us: Unit[]) => us.reduce((n, u) => n + u.text.length + u.sep.length, 0);

  for (const unit of units) {
    if (unit.isHeading) {
      // Every heading starts a new chunk. Overlap and heading-only leftovers are dropped
      // so text from the previous section never leaks under the new section's label.
      if (current.slice(freshFrom).some((u) => !u.isHeading)) emit();
      current = [unit];
      currentTokens = unit.tokens;
      freshFrom = 0;
      continue;
    }
    const unitChars = unit.text.length + unit.sep.length;
    if (
      current.length > freshFrom &&
      (currentTokens + unit.tokens > opts.targetTokens ||
        charsOf(current) + unitChars > opts.maxChars)
    ) {
      emit();
      // If overlap + new unit would exceed a cap, drop the overlap.
      if (currentTokens + unit.tokens > opts.maxTokens || charsOf(current) + unitChars > opts.maxChars) {
        current = [];
        currentTokens = 0;
        freshFrom = 0;
      }
    }
    current.push(unit);
    currentTokens += unit.tokens;
  }
  if (current.slice(freshFrom).some((u) => !u.isHeading)) emit();

  return chunks.map((c, i) => ({ ...c, index: i }));
}
