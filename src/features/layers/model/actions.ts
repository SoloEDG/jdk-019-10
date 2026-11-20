import { doc } from "../../../shared/document";
import {
  deleteShapes,
  reorderShapes,
  setFields,
} from "../../collab/model/session";
export function group() {
  const selected = doc.shapes.filter((s) => doc.selected.includes(s.id));
  if (selected.length < 2) return;
  const id = crypto.randomUUID();
  const top = doc.shapes
    .map((s) => doc.selected.includes(s.id))
    .lastIndexOf(true);
  const below = doc.shapes
    .slice(0, top + 1)
    .filter((s) => !doc.selected.includes(s.id));
  const above = doc.shapes.slice(top + 1);
  setFields(
    selected.map((s) => s.id),
    "group",
    id,
  );
  reorderShapes([...below, ...selected, ...above].map((s) => s.id));
}
export function reorder(delta: number) {
  const first = doc.shapes.find((s) => doc.selected.includes(s.id));
  if (!first) return;
  const blocks: (typeof doc.shapes)[] = [];
  for (const shape of doc.shapes) {
    const last = blocks.at(-1);
    if (shape.group && last?.[0].group === shape.group) last.push(shape);
    else blocks.push([shape]);
  }
  const i = blocks.findIndex((b) => b.some((s) => s.id === first.id)),
    j = i + delta;
  if (j < 0 || j >= blocks.length) return;
  [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  reorderShapes(blocks.flat().map((s) => s.id));
}
export function remove() {
  if (doc.selected.length === 0) return;
  deleteShapes([...doc.selected]);
  doc.selected = [];
}
