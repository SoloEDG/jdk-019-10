/** Deterministic per-writer accent colour for presence and conflict toasts. */
const PALETTE = [
  "#6f52d4",
  "#d4557a",
  "#1f9a86",
  "#c5882c",
  "#3d7bd0",
  "#a04fc4",
  "#678a2e",
  "#c26a35",
];
export function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++)
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
