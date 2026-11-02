export function pendingBatchText(rows) {
  return (rows || [])
    .map((row) => String(row == null ? "" : row).trim())
    .filter(Boolean)
    .join("\n\n");
}
