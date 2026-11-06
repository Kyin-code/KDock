/** Width for the line-number gutter. Keep a readable 3-digit minimum while
 *  growing with the actual line count so 1000+ never wraps digit-by-digit. */
export function logNumberColumnWidth(maxNumber) {
  const value = Math.max(1, Math.floor(Number(maxNumber) || 0));
  const digits = Math.max(3, String(value).length);
  return `calc(${digits}ch + 1.6rem)`;
}
