/**
 * Which blocks the store keeps as blobs, and the media type a blob's bytes
 * name. Shared by the store (blob-manager.ts) and the write boundary
 * (well-formed-content.ts), so the boundary refuses exactly what the store's
 * own read of a source refuses.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { BlobReference } from './types/index.js';

/** Detect provider-supported raster image types from their byte signature.
 * Returns null for unknown/container types so callers can preserve the
 * declared MIME rather than guessing. */
export function sniffRasterImageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
      Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** The raster image type base64 data's first bytes name, or null: what
 *  sniffRasterImageMediaType gives for the whole decode, with only a prefix
 *  decoded, so a multi-megabyte payload isn't copied in full. A prefix of a
 *  string decodes to the first bytes of the whole string's decode, and the
 *  longest signature needs 12 bytes, which 32 base64 characters cover with
 *  room to spare (24). The prefix doubles until it gives 12 bytes or is the
 *  whole string, for data whose first characters aren't base64, which the
 *  decode skips. */
export function imageMediaTypeOfBase64(data: string): string | null {
  let length = 32;
  let bytes = Buffer.from(data.slice(0, length), 'base64');
  while (bytes.length < 12 && length < data.length) {
    length *= 2;
    bytes = Buffer.from(data.slice(0, length), 'base64');
  }
  return sniffRasterImageMediaType(bytes);
}

/**
 * The blob a block is kept as, by its original type, or null for a block the
 * store keeps as given. Inline media becomes a blob: an image whose source
 * isn't a URL, and every document, audio or video block.
 */
export function blobKindOf(block: ContentBlock): BlobReference['originalType'] | null {
  switch (block.type) {
    case 'image':
      return block.source.type === 'url' ? null : 'image';
    case 'document':
    case 'audio':
    case 'video':
      return block.type;
    default:
      return null;
  }
}

/**
 * What the store can't keep of inline media's source, by its own write of it
 * (storeBase64), or null when it can keep the block: `data` when the data
 * doesn't read as base64, and `mediaType` when the blob would have no media
 * type, neither a declared one nor, for an image, one its data's signature
 * names. A block the store keeps as given (blobKindOf) has neither. The
 * reads are the store's, done no further than they need: any string reads as
 * base64, so string data isn't decoded, and an image without a declared type
 * has a prefix of its data decoded (imageMediaTypeOfBase64). Data that isn't
 * a string is read as the store reads it (Buffer.from), which takes an array
 * of bytes, for one.
 */
export function unstorableSource(block: ContentBlock): { data: boolean; mediaType: boolean } | null {
  const kind = blobKindOf(block);
  if (!kind) return null;
  const { data, mediaType } = (block as { source: { data?: unknown; mediaType?: unknown } }).source;
  let bytes: Uint8Array | null = null;
  if (typeof data !== 'string') {
    try {
      bytes = Buffer.from(data as string, 'base64');
    } catch {
      return { data: true, mediaType: typeof mediaType !== 'string' };
    }
  }
  if (typeof mediaType === 'string') return null;
  if (kind !== 'image') return { data: false, mediaType: true };
  const sniffed = typeof data === 'string' ? imageMediaTypeOfBase64(data) : sniffRasterImageMediaType(bytes!);
  return sniffed === null ? { data: false, mediaType: true } : null;
}
