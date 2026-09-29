import { PROJECT_IMAGE_ICON_MAX_DATA_URL_LENGTH } from "@t3tools/contracts";

export const PROJECT_ICON_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";
export const PROJECT_ICON_IMAGE_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
// Largest first. 128px stays crisp on 2x displays at the 48px preview; smaller sizes only
// run when a busy photo will not fit the inline cap at the first size.
export const PROJECT_ICON_IMAGE_SIZES = [128, 96, 64] as const;

const ACCEPTED_MIME_TYPES = new Set(PROJECT_ICON_IMAGE_ACCEPT.split(","));
const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export function validateProjectIconImageFile(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = file.type || MIME_TYPE_BY_EXTENSION[extension] || "";
  if (!ACCEPTED_MIME_TYPES.has(mimeType)) return "Choose a PNG, JPG, WebP, or SVG image.";
  if (file.size > PROJECT_ICON_IMAGE_MAX_SOURCE_BYTES) return "Choose an image under 5 MB.";
  return null;
}

/** The centered square that fills an icon, so wide or tall images are cropped, not squashed. */
export function centerSquareCrop(width: number, height: number) {
  const side = Math.min(width, height);
  return { sx: (width - side) / 2, sy: (height - side) / 2, side };
}

/** Renders at each size in turn and returns the first result that fits the inline cap. */
export function fitProjectIconDataUrl(render: (size: number) => string): string | null {
  for (const size of PROJECT_ICON_IMAGE_SIZES) {
    const dataUrl = render(size);
    if (dataUrl.length <= PROJECT_IMAGE_ICON_MAX_DATA_URL_LENGTH) return dataUrl;
  }
  return null;
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Crops the file to a square and downscales it to an inline data URL. SVGs are rasterized
 * through an <img>, which never runs their scripts, so only bitmap data is ever stored.
 */
export async function createProjectIconDataUrl(file: File): Promise<string> {
  const image = await loadImage(file);
  const { sx, sy, side } = centerSquareCrop(image.naturalWidth || 128, image.naturalHeight || 128);
  const canvas = document.createElement("canvas");
  const dataUrl = fitProjectIconDataUrl((size) => {
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.clearRect(0, 0, size, size);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sx, sy, side, side, 0, 0, size, size);
    // Browsers without WebP encoding return PNG, which the contract also accepts.
    return canvas.toDataURL("image/webp", 0.9);
  });
  if (dataUrl === null) throw new Error("That image is too detailed to use as an icon.");
  return dataUrl;
}
