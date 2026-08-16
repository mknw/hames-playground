/**
 * Turn Color Palette
 *
 * High-contrast colors for per-turn graph visualization on dark theme.
 */

export const TURN_COLORS = [
  '#00ffff', // cyan
  '#ff6b6b', // coral
  '#ffd93d', // gold
  '#6bcb77', // green
  '#4d96ff', // blue
  '#ff6fff', // pink
  '#ff8c42', // orange
  '#a855f7', // purple
  '#06d6a0', // teal
  '#e0aaff', // lavender
] as const

export function getTurnColor(turnNumber: number): string {
  return TURN_COLORS[(turnNumber - 1) % TURN_COLORS.length]
}
