import type { Node } from "../../../shared/types";
import { findNode, mirrorNode, writeNode } from "../../collab/model/session";

export type Handle = "anchor" | "in" | "out";

/**
 * Live drag previews are recomputed from the committed snapshot plus the
 * gesture's cumulative delta, never from the previous frame. That way a remote
 * change arriving mid-drag replaces the mirror without the preview jumping, and
 * the final commit merges with the peer's write instead of reverting it.
 */
export function previewAnchor(
  shapeId: string,
  nodeId: string,
  kind: Handle,
  dx: number,
  dy: number,
) {
  const base = findNode(shapeId, nodeId);
  const node = mirrorNode(shapeId, nodeId) as Node | undefined;
  if (!base || !node) return;
  if (kind === "anchor") {
    node.x = base.x + dx;
    node.y = base.y + dy;
    node.in.x = base.in.x + dx;
    node.in.y = base.in.y + dy;
    node.out.x = base.out.x + dx;
    node.out.y = base.out.y + dy;
  } else {
    Object.assign(node, { x: base.x, y: base.y });
    node.in.x = base.in.x;
    node.in.y = base.in.y;
    node.out.x = base.out.x;
    node.out.y = base.out.y;
    node[kind].x = base[kind].x + dx;
    node[kind].y = base[kind].y + dy;
  }
}

/** Commit a finished anchor/handle drag as one op. */
export function commitAnchor(
  shapeId: string,
  nodeId: string,
  kind: Handle,
  dx: number,
  dy: number,
) {
  const base = findNode(shapeId, nodeId);
  if (!base || (!dx && !dy)) return;
  const moved: Node = {
    id: base.id,
    x: base.x,
    y: base.y,
    in: { ...base.in },
    out: { ...base.out },
  };
  if (kind === "anchor") {
    moved.x += dx;
    moved.y += dy;
    moved.in.x += dx;
    moved.in.y += dy;
    moved.out.x += dx;
    moved.out.y += dy;
  } else {
    moved[kind].x += dx;
    moved[kind].y += dy;
  }
  writeNode(shapeId, moved);
}
