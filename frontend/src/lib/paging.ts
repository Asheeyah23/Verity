export const PAGE_SIZE = 25;
export const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) + 1;

/**
 * Reads ?page= as a positive integer, defaulting to 1 for anything else.
 * Rejects non-base-10 strings, leading zeros, exponents, signs, and page numbers
 * whose backend offset would exceed Number.MAX_SAFE_INTEGER.
 */
export function parsePage(raw: string | string[] | undefined): number {
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str || !/^[1-9]\d*$/.test(str)) return 1;
  const n = Number(str);
  return Number.isSafeInteger(n) && (n - 1) * PAGE_SIZE <= Number.MAX_SAFE_INTEGER ? n : 1;
}
