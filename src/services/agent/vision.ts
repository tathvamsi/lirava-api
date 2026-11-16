/**
 * Prepares attached images for a vision model: reads each file the user owns and turns it into an
 * OpenAI-style image part (a data URL). Only formats the model server can decode are sent.
 */
import { getFileForUser } from "../files/index.js";

/** Most images sent with one message; every image costs about 1,000 to 1,500 tokens of the window. */
export const MAX_IMAGES = 2;
/** Largest image sent as is. Bigger ones are reported as unreadable instead of sent. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SENDABLE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };

/** The image type this file name is, when the model server can decode it (WebP and the rest are not). */
export function sendableImageType(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name || "")?.[1]?.toLowerCase();
  return ext ? SENDABLE[ext] ?? null : null;
}

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || "");

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

/** Reads the image files and returns the parts the model can see, plus the names of any that could not be sent. */
export async function loadImageParts(
  files: Array<{ id: string; name: string }>,
  userId: string,
): Promise<{ parts: ImagePart[]; names: string[]; skipped: string[] }> {
  const parts: ImagePart[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const mime = sendableImageType(file.name);
    if (!mime || parts.length >= MAX_IMAGES) {
      skipped.push(file.name);
      continue;
    }
    const stored = await getFileForUser(file.id, userId).catch(() => null);
    if (!stored || stored.data.length === 0 || stored.data.length > MAX_IMAGE_BYTES) {
      skipped.push(file.name);
      continue;
    }
    parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${stored.data.toString("base64")}` } });
    names.push(file.name);
  }
  return { parts, names, skipped };
}
