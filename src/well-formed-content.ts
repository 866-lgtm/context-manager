/**
 * Content that matches `ContentBlock` where its readers read it. Every block
 * is an object, and the field that carries its content has its type:
 *   - a `text` block's `text` and a `thinking` block's `thinking` are strings;
 *   - a `tool_use`'s `input` is an object, not null and not an array;
 *   - a `tool_result`'s `content` is a string, or an array of such blocks,
 *     at any depth.
 * Nothing else is checked: not ids, names or signatures, and not media
 * sources, whose readers guard them. A provider may still refuse a block
 * that is missing one of those.
 *
 * Every reader of stored content, from the token estimators to compression
 * and the formatters, is written against `ContentBlock`, and a reader that
 * meets content that doesn't match it can throw. A stored message holding a
 * block that isn't an object made every compile throw, under every strategy
 * and after a reopen too, until someone edited the store by hand. Under the
 * autobiographical strategy, so did a text or thinking block missing its
 * text or thinking, whose token estimate reads the field's length.
 *
 * So the stores refuse such content on write ({@link refuseMalformedContent}),
 * and a read leaves it out ({@link wellFormedContent}) for a store written
 * before the refusal, which keeps the content as written.
 *
 * Content is walked with index loops throughout: a hole in an array reads as
 * undefined, so it is named and refused like any other. (A stored record has
 * no holes, since JSON writes a hole as null.)
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { StoredContentBlock } from './types/index.js';
import { releaseEditedRawForms } from './raw-forms.js';

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** An object that isn't an array: what a `tool_use`'s `input` must be. */
function isRecord(value: unknown): boolean {
  return isObject(value) && !Array.isArray(value);
}

/** What a value is, for the line that names it: "null", "undefined", "an array", "a string", "an object". */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/** Whether a block matches `ContentBlock` where its readers read it, without allocating: the read path's common case. */
function wellFormed(block: unknown): boolean {
  if (!isObject(block)) return false;
  const fields = block as { type?: unknown; text?: unknown; thinking?: unknown; input?: unknown; content?: unknown };
  switch (fields.type) {
    case 'text':
      return typeof fields.text === 'string';
    case 'thinking':
      return typeof fields.thinking === 'string';
    case 'tool_use':
      return isRecord(fields.input);
    case 'tool_result': {
      const inner = fields.content;
      if (typeof inner === 'string') return true;
      if (!Array.isArray(inner)) return false;
      for (let i = 0; i < inner.length; i++) if (!wellFormed(inner[i])) return false;
      return true;
    }
    default:
      return true;
  }
}

function allWellFormed(content: readonly unknown[]): boolean {
  for (let i = 0; i < content.length; i++) if (!wellFormed(content[i])) return false;
  return true;
}

/**
 * Each place in `block` that doesn't match `ContentBlock`, as a phrase naming
 * its path from `at` ("content[2] is a string, not a content block",
 * "content[0].content is null, not a string or an array of content blocks"),
 * added to `places` in content order.
 */
function placesIn(block: unknown, at: string, places: string[]): void {
  if (!isObject(block)) {
    places.push(`${at} is ${kindOf(block)}, not a content block`);
    return;
  }
  const fields = block as { type?: unknown; text?: unknown; thinking?: unknown; input?: unknown; content?: unknown };
  switch (fields.type) {
    case 'text':
      if (typeof fields.text !== 'string') places.push(`${at}.text is ${kindOf(fields.text)}, not a string`);
      return;
    case 'thinking':
      if (typeof fields.thinking !== 'string') places.push(`${at}.thinking is ${kindOf(fields.thinking)}, not a string`);
      return;
    case 'tool_use':
      if (!isRecord(fields.input)) places.push(`${at}.input is ${kindOf(fields.input)}, not an object`);
      return;
    case 'tool_result': {
      const inner = fields.content;
      if (typeof inner === 'string') return;
      if (!Array.isArray(inner)) {
        places.push(`${at}.content is ${kindOf(inner)}, not a string or an array of content blocks`);
        return;
      }
      for (let i = 0; i < inner.length; i++) placesIn(inner[i], `${at}.content[${i}]`, places);
      return;
    }
  }
}

function malformedPlaces(content: readonly unknown[]): string[] {
  const places: string[] = [];
  for (let i = 0; i < content.length; i++) placesIn(content[i], `content[${i}]`, places);
  return places;
}

/**
 * Refuse content that doesn't match `ContentBlock`, before anything of it is
 * stored. `what` opens the error ("Message refused", "Edit of m-12 refused").
 */
export function refuseMalformedContent(content: readonly unknown[], what: string): void {
  if (allWellFormed(content)) return;
  throw new Error(`${what}: ${malformedPlaces(content).join('; ')}.`);
}

/** As refuseMalformedContent, for one block, whose places are named from `block`. */
export function refuseMalformedBlock(block: unknown, what: string): void {
  if (wellFormed(block)) return;
  const places: string[] = [];
  placesIn(block, 'block', places);
  throw new Error(`${what}: ${places.join('; ')}.`);
}

/**
 * `content`'s blocks as a read gives them (wellFormedBlock), leaving out the
 * ones it drops. Every block that shares a raw replay form with a block the
 * read changed or left out gives that form up, as after any edit
 * (raw-forms.ts), since replaying it would carry what was left out. A
 * `tool_result`'s content is read through here too, so each level is
 * reconciled on its own, and a block mended inside a `tool_result` gives up
 * its form like one at the top.
 */
function wellFormedBlocks(content: readonly unknown[]): ContentBlock[] {
  const before: ContentBlock[] = [];
  const after: ContentBlock[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    // A value that isn't an object carries no raw form; it is left out.
    if (!isObject(block)) continue;
    before.push(block as ContentBlock);
    const read = wellFormedBlock(block);
    if (read) after.push(read);
  }
  return releaseEditedRawForms(before, after);
}

/**
 * A block as a read gives it: the block itself when it matches `ContentBlock`.
 * Otherwise a `tool_use` is copied with `{}` for its input, and a
 * `tool_result` with well-formed content (its well-formed blocks, or an empty
 * array in place of content that is neither a string nor an array), so that
 * the pair they make survives. Anything else, which is a value that isn't an
 * object or a text or thinking block without its string, is left out
 * (undefined).
 */
function wellFormedBlock(block: unknown): ContentBlock | undefined {
  if (wellFormed(block)) return block as ContentBlock;
  if (!isObject(block)) return undefined;
  const fields = block as { type?: unknown; content?: unknown };
  if (fields.type === 'tool_use') return { ...block, input: {} } as ContentBlock;
  if (fields.type === 'tool_result') {
    const inner = fields.content;
    return { ...block, content: Array.isArray(inner) ? wellFormedBlocks(inner) : [] } as ContentBlock;
  }
  return undefined;
}

/**
 * Stored content as a read gives it: what doesn't match `ContentBlock` is
 * left out or made to match (wellFormedBlock), at any depth, and the store
 * keeps the content as written. Content that matches is returned as it is.
 * Otherwise every block that shares a raw replay form with a block the read
 * changed or left out gives that form up, in the message's content and in
 * each `tool_result`'s content within it (wellFormedBlocks). The first read
 * of each record in `logged` logs one line naming what it leaves out.
 * `where` names the record ("message m-12", "context entry 3"), and keys
 * that line: a message by its id, a context entry by its index.
 */
export function wellFormedContent(
  content: StoredContentBlock[],
  where: string,
  logged: Set<string>,
): StoredContentBlock[] {
  if (allWellFormed(content)) return content;
  if (!logged.has(where)) {
    logged.add(where);
    console.error(
      `[context-manager] ${where}: reads leave out what doesn't match ContentBlock (${malformedPlaces(content).join('; ')}); ` +
        'the store keeps it as written',
    );
  }
  return wellFormedBlocks(content) as StoredContentBlock[];
}
