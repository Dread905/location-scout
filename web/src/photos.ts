/** Browser photo pipeline: read EXIF, then re-encode to WebP (which also strips EXIF, so no GPS leaks). */
import exifr from 'exifr';

export interface PhotoMeta { lat: number | null; lng: number | null; takenAt: Date | null }

export async function readExif(file: File): Promise<PhotoMeta> {
  try {
    const m = await exifr.parse(file, { gps: true, pick: ['DateTimeOriginal', 'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'] });
    const ok = typeof m?.latitude === 'number' && typeof m?.longitude === 'number';
    return { lat: ok ? m.latitude : null, lng: ok ? m.longitude : null, takenAt: m?.DateTimeOriginal instanceof Date ? m.DateTimeOriginal : null };
  } catch {
    return { lat: null, lng: null, takenAt: null };
  }
}

/** Scale so the long edge is at most `maxEdge`, as WebP. */
export async function resize(file: Blob, maxEdge: number, quality = 0.85): Promise<{ blob: Blob; w: number; h: number }> {
  const img = await createImageBitmap(file); // applies EXIF orientation
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
  img.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', quality));
  if (!blob) throw new Error('This browser could not encode WebP');
  return { blob, w, h };
}

export async function prepareUpload(file: File) {
  const [full, thumb] = await Promise.all([resize(file, 2048), resize(file, 400, 0.8)]);
  return { photo: full.blob, thumb: thumb.blob, w: full.w, h: full.h };
}
