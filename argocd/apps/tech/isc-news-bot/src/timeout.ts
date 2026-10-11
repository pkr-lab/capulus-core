export const BASE_TIMEOUT_MS = 120_000;
export const PER_IMAGE_EXTRA_MS = 60_000;

export function overallTimeoutMs(imageCount: number, uploadSettleMs: number): number {
  return BASE_TIMEOUT_MS + imageCount * (uploadSettleMs + PER_IMAGE_EXTRA_MS);
}
