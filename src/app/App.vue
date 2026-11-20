<script setup lang="ts">
import { watch } from "vue";
import { doc } from "../shared/document";
import {
  Tools,
  path,
  create,
  anchor,
  beginEdit,
  endEdit,
  undo,
  redo,
} from "../features/drawing";
import { NodeOverlay, coordinates, select } from "../features/nodes";
import { Properties } from "../features/appearance";
import { Layers, commitTranslate, previewTranslate } from "../features/layers";
import { ExportBar } from "../features/export";
import {
  addNode,
  initSession,
  syncLabel,
  syncHealthy,
} from "../features/collab/model/session";
import { PresenceBar } from "../features/collab/ui";
import { Notices } from "../features/collab/ui";
import type { Node, Shape } from "../shared/types";

initSession();
let drawing: Shape | undefined;

watch(
  () => doc.tool,
  () => {
    drawing = undefined;
  },
);

function down(e: PointerEvent) {
  const svg = e.currentTarget as SVGSVGElement;
  const p = coordinates(e, svg);
  const id = (e.target as Element).getAttribute("data-shape");
  if (doc.tool === "pen") {
    if (!drawing) {
      beginEdit();
      drawing = create();
      if (!drawing) {
        endEdit();
        return;
      }
      const first: Node = anchor(p);
      addNode(drawing.id, first);
      drawing.nodes.push(first);
    } else {
      beginEdit();
      const n: Node = anchor(p);
      addNode(drawing.id, n);
      drawing.nodes.push(n);
    }
    const n = drawing.nodes.at(-1)!;
    const shapeId = drawing.id;
    const f = (ev: PointerEvent) => {
      const q = coordinates(ev, svg);
      n.out = q;
      n.in = { x: 2 * n.x - q.x, y: 2 * n.y - q.y };
    };
    const up = () => {
      window.removeEventListener("pointermove", f);
      addNode(shapeId, n);
      endEdit();
    };
    window.addEventListener("pointermove", f);
    window.addEventListener("pointerup", up, { once: true });
  } else if (id) {
    select(id, e.shiftKey);
    if (doc.tool === "nodes") return;
    let last = p;
    const start = p;
    beginEdit();
    const f = (ev: PointerEvent) => {
      const q = coordinates(ev, svg);
      previewTranslate(q.x - last.x, q.y - last.y);
      last = q;
    };
    const up = () => {
      window.removeEventListener("pointermove", f);
      commitTranslate(last.x - start.x, last.y - start.y);
      endEdit();
    };
    window.addEventListener("pointermove", f);
    window.addEventListener("pointerup", up, { once: true });
  } else doc.selected = [];
}
function finish() {
  drawing = undefined;
  endEdit();
  doc.tool = "select";
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Escape") finish();
});
</script>
<template>
  <header>
    <b class="brand">◈ forma <small>VECTOR STUDIO</small></b>
    <div>Bloom exploration <span> / Personal workspace</span></div>
    <PresenceBar />
    <ExportBar />
  </header>
  <div class="workspace">
    <div class="left">
      <h5>PROJECT <span>＋</span></h5>
      <p class="project">▣ Bloom / Artboard 01</p>
      <Tools /><Layers />
      <p class="signature">✧ Designed to explore.</p>
    </div>
    <main>
      <div class="toolbar">
        <span>Artboard 01　<small>800 × 600</small></span>
        <div>
          <button @click="undo" data-testid="undo">↶</button
          ><button @click="redo" data-testid="redo">↷</button
          ><button @click="doc.zoom = Math.max(0.4, doc.zoom - 0.1)">−</button
          >{{ Math.round(doc.zoom * 100) }}%<button
            @click="doc.zoom = Math.min(1.5, doc.zoom + 0.1)"
          >
            ＋
          </button>
        </div>
      </div>
      <div class="stage">
        <svg
          data-testid="canvas"
          :style="{
            width: 800 * doc.zoom + 'px',
            height: 600 * doc.zoom + 'px',
          }"
          viewBox="0 0 800 600"
          @pointerdown="down"
          @dblclick="finish"
        >
          <rect width="800" height="600" fill="#fffdfb" />
          <path
            v-for="s in doc.shapes"
            :key="s.id"
            :data-shape="s.id"
            :d="path(s)"
            :fill="s.fill"
            :stroke="s.stroke"
            :stroke-width="s.width"
            :opacity="s.opacity"
          />
          <NodeOverlay />
        </svg>
      </div>
      <footer>
        <span data-testid="sync-status" :class="{ live: syncHealthy }"
          >● {{ syncLabel }}</span
        ><span>{{
          doc.tool === "pen"
            ? "Click / drag to draw · Enter to finish"
            : "Shift + click to select multiple · Drag to move"
        }}</span
        ><span>{{ doc.selected.length }} selected</span>
      </footer>
    </main>
    <Properties />
  </div>
  <Notices />
</template>
