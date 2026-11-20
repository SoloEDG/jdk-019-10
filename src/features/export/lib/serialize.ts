import { exportSnapshot } from "../../collab/model/session";
import { path } from "../../drawing/lib/path";
import type { Shape } from "../../../shared/types";

/**
 * Serialize the committed snapshot only — never the live mirror, which may be
 * mid-drag — so an export is always one clearly identified version.
 */
export function serialize() {
  const shapes = exportSnapshot().shapes as unknown as Shape[];
  const d = shapes.map(path);
  let content = "",
    group: string | undefined;
  shapes.forEach((s, i) => {
    if (s.group !== group) {
      if (group) content += "</g>";
      group = s.group;
      if (group) content += `<g id="group-${group}-${i}">`;
    }
    content += `<path d="${d[i]}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="${s.width}" opacity="${s.opacity}"/>`;
  });
  if (group) content += "</g>";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">${content}</svg>`;
}
