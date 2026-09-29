export const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

export interface PngIconImage {
  readonly size: number;
  readonly contents: Buffer;
}

/** Encodes PNG renditions directly into a modern, multi-resolution ICO file. */
export function encodePngIco(images: ReadonlyArray<PngIconImage>): Buffer {
  if (images.length === 0) {
    throw new Error("An ICO file requires at least one PNG rendition.");
  }

  const seenSizes = new Set<number>();
  for (const image of images) {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new Error(`ICO rendition size must be an integer from 1 to 256, got ${image.size}.`);
    }
    if (seenSizes.has(image.size)) {
      throw new Error(`ICO rendition size ${image.size} was provided more than once.`);
    }
    if (image.contents.length === 0) {
      throw new Error(`ICO rendition ${image.size}x${image.size} is empty.`);
    }
    seenSizes.add(image.size);
  }

  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = directoryEntrySize * images.length;
  const header = Buffer.alloc(headerSize + directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = header.length;
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * directoryEntrySize;
    const encodedSize = image.size === 256 ? 0 : image.size;
    header.writeUInt8(encodedSize, entryOffset);
    header.writeUInt8(encodedSize, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.contents.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.contents.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.contents)]);
}
