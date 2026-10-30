/**
 * Modal Function list prices, read 2026-10-30:
 * https://modal.com/pricing and https://modal.com/docs/guide/region-selection
 * Region is the container's COMPUTE region; routing_region does not price it.
 */
export const MODAL_LIST_PRICES_USD = {
  gpuPerHour: { H100: 3.95, A10: 1.1, L4: 0.8 },
  cpuPerCoreSecond: 0.0000131,
  memoryPerGiBSecond: 0.00000222,
  regionMultiplier: { eu: 1.15, 'eu-west': 1.75 },
} as const

export const MODAL_BOXES = {
  large: { gpu: 'H100', cores: 4, memoryGiB: 64, computeRegion: 'eu' },
  smallL4: { gpu: 'L4', cores: 2, memoryGiB: 24, computeRegion: 'eu' },
  smallA10: { gpu: 'A10', cores: 2, memoryGiB: 24, computeRegion: 'eu' },
} as const

export function modalBoxUsdPerHour(
  gpu: keyof typeof MODAL_LIST_PRICES_USD.gpuPerHour,
  cores: number,
  memoryGiB: number,
  computeRegion: keyof typeof MODAL_LIST_PRICES_USD.regionMultiplier,
): number {
  const rates = MODAL_LIST_PRICES_USD
  return (
    (rates.gpuPerHour[gpu] +
      cores * rates.cpuPerCoreSecond * 3600 +
      memoryGiB * rates.memoryPerGiBSecond * 3600) *
    rates.regionMultiplier[computeRegion]
  )
}

export function modalDefaultUsdPerHour(box: keyof typeof MODAL_BOXES): number {
  const { gpu, cores, memoryGiB, computeRegion } = MODAL_BOXES[box]
  return modalBoxUsdPerHour(gpu, cores, memoryGiB, computeRegion)
}
