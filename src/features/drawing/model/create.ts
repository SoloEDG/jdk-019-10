import type { NodeLite } from "../../collab/model/crdt";
import type { Point } from "../../../shared/types";
import { createShape, type ShapeDraft } from "../../collab/model/session";

/** Start a pen path; its first anchor is added by the caller. */
export function create(): ShapeDraft {
  const draft: ShapeDraft = {
    id: crypto.randomUUID(),
    name: "Pen path",
    nodes: [],
    closed: false,
    fill: "none",
    stroke: "#7754dc",
    width: 3,
    opacity: 1,
  };
  createShape(draft);
  return draft;
}

/** Build an anchor; ids make each point addressable across windows. */
export function anchor(p: Point): NodeLite {
  return {
    id: crypto.randomUUID(),
    x: p.x,
    y: p.y,
    in: { x: p.x, y: p.y },
    out: { x: p.x, y: p.y },
  };
}
