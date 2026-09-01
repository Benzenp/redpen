/**
 * High-contrast color palette for Instruction Groups (docs/PRODUCT_INTENT.md §7,
 * docs/ARCHITECTURE.md §3.6: "고대비 팔레트에서 자동 배정", "팔레트가 순환하더라도
 * 번호는 재사용하지 않는다").
 */

export const GROUP_COLOR_PALETTE: readonly string[] = [
  '#dc2626', // red
  '#2563eb', // blue
  '#16a34a', // green
  '#f59e0b', // amber
  '#9333ea', // purple
  '#0d9488', // teal
  '#db2777', // pink
  '#65a30d', // lime
];

/**
 * Color assignment cycles through the palette but the *group number* keeps
 * incrementing forever — colors may repeat, numbers never do.
 */
export function colorForGroupNumber(number: number): string {
  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError(`group number must be a positive integer, got ${number}`);
  }
  return GROUP_COLOR_PALETTE[(number - 1) % GROUP_COLOR_PALETTE.length];
}
