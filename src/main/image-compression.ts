import { nativeImage } from 'electron'

/** Caps applied before images are uploaded to the AI provider */
const API_MAX_WIDTH = 1600
const API_JPEG_QUALITY = 78

/**
 * Compress a raw base64 PNG screenshot for the AI request payload. Full-size
 * PNGs can be several megabytes each and get rejected by provider gateways
 * (nginx 413); downscaled JPEG keeps text readable at a fraction of the size.
 * Returns a data URL, falling back to the original PNG on any failure.
 */
export function compressForApi(pngBase64: string): string {
  try {
    let image = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'))
    if (image.isEmpty()) {
      return `data:image/png;base64,${pngBase64}`
    }
    if (image.getSize().width > API_MAX_WIDTH) {
      image = image.resize({ width: API_MAX_WIDTH })
    }
    const jpeg = image.toJPEG(API_JPEG_QUALITY)
    if (!jpeg.length) {
      return `data:image/png;base64,${pngBase64}`
    }
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch (error) {
    console.error('Error compressing screenshot for API:', error)
    return `data:image/png;base64,${pngBase64}`
  }
}
