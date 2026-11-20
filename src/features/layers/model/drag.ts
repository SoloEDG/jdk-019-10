import { doc } from "../../../shared/document";
import { findNode, writeNodes } from "../../collab/model/session";
import { previewAnchor } from "../../nodes/model/move";
import type { NodeLite } from "../../collab/model/crdt";

/**
 * Whole-layer drag: the same per-anchor preview/commit as a single anchor, so
 * a drag sends one batch of anchor deltas instead of the whole document.
 */
export function previewTranslate(dx: number, dy: number) {
  for (const shape of doc.shapes) {
    if (!doc.selected.includes(shape.id)) continue;
    for (const node of shape.nodes)
      previewAnchor(shape.id, node.id, "anchor", dx, dy);
  }
}

export function commitTranslate(dx: number, dy: number) {
  if (!dx && !dy) return;
  const entries: { shapeId: string; node: NodeLite }[] = [];
  for (const shape of doc.shapes) {
    if (!doc.selected.includes(shape.id)) continue;
    for (const node of shape.nodes) {
      const base = findNode(shape.id, node.id);
      if (!base) continue;
      entries.push({
        shapeId: shape.id,
        node: {
          id: base.id,
          x: base.x + dx,
          y: base.y + dy,
          in: { x: base.in.x + dx, y: base.in.y + dy },
          out: { x: base.out.x + dx, y: base.out.y + dy },
        },
      });
    }
  }
  writeNodes(entries);
}
