// Every "photo" in this app is a data URI baked directly into a DHT entry --
// there's no image host to upload to instead (see the doc comments on
// Profile.avatar_data_uri et al.). That makes size discipline a real
// correctness concern, not just a nice-to-have: an unbounded photo would
// bloat every peer that ever validates or stores this entry, forever. This
// resizes+recompresses client-side before anything is ever sent to the
// conductor, and refuses outright past a hard ceiling rather than silently
// uploading something huge.

import { t } from "../../i18n";
import { currentTerms } from "../../store/network";

const MAX_DIMENSION = 640;
const JPEG_QUALITY = 0.72;

export async function fileToResizedDataUri(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);

  const dataUri = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  // The network's ceiling (`max_image_bytes`) -- validation refuses more.
  if (dataUri.length > currentTerms().max_image_bytes) {
    throw new Error(t("image.tooLarge", { size: Math.round(dataUri.length / 1024) }));
  }
  return dataUri;
}
