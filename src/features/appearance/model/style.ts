import { doc } from "../../../shared/document";
import { setFields } from "../../collab/model/session";
import type { Shape } from "../../../shared/types";
export function style<K extends keyof Shape>(k: K, v: Shape[K]) {
  const field = k as "fill" | "stroke" | "width" | "opacity" | "closed";
  setFields(
    doc.selected.filter((id) => doc.shapes.some((s) => s.id === id)),
    field,
    v,
  );
}
