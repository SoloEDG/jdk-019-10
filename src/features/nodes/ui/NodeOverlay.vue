<script setup lang="ts">
import { beginEdit, endEdit } from "../../collab/model/session";
import { doc } from "../../../shared/document";
import { previewAnchor, commitAnchor, type Handle } from "../model/move";
import { coordinates } from "../lib/coordinates";
import type { Node, Point } from "../../../shared/types";

function drag(e: PointerEvent, shapeId: string, node: Node, kind: Handle) {
  e.stopPropagation();
  const svg = (e.target as SVGElement).ownerSVGElement!;
  if (!doc.shapes.some((s) => s.id === shapeId)) return;
  beginEdit();
  const origin = { ...(kind === "anchor" ? node : node[kind]) };
  let dx = 0;
  let dy = 0;
  const f = (ev: PointerEvent) => {
    const p: Point = coordinates(ev, svg);
    dx = p.x - origin.x;
    dy = p.y - origin.y;
    previewAnchor(shapeId, node.id, kind, dx, dy);
  };
  const up = () => {
    window.removeEventListener("pointermove", f);
    commitAnchor(shapeId, node.id, kind, dx, dy);
    endEdit();
  };
  window.addEventListener("pointermove", f);
  window.addEventListener("pointerup", up, { once: true });
}
</script>
<template>
  <g v-for="s in doc.shapes.filter((s) => doc.selected.includes(s.id))"
    ><g v-for="n in s.nodes"
      ><path
        :d="`M${n.in.x},${n.in.y} L${n.x},${n.y} L${n.out.x},${n.out.y}`"
        stroke="#9974ec"
        fill="none" /><circle
        v-for="k in ['in', 'out'] as const"
        :cx="n[k].x"
        :cy="n[k].y"
        r="4"
        fill="white"
        stroke="#8052df"
        @pointerdown="drag($event, s.id, n, k)" /><rect
        :x="n.x - 4"
        :y="n.y - 4"
        width="8"
        height="8"
        fill="white"
        stroke="#8052df"
        data-testid="anchor"
        @pointerdown="drag($event, s.id, n, 'anchor')" /></g
  ></g>
</template>
