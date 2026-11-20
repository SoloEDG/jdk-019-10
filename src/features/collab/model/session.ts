/**
 * Multi-window collaboration session.
 *
 * - Local view state (selection, zoom, active tool) stays in `doc` and is
 *   never shared, so every window keeps its own selection and viewport.
 * - Document edits are per-object operations merged by `crdt.ts` and sent as
 *   small deltas over a same-origin BroadcastChannel (no server).
 * - A compact snapshot is exchanged only when a window joins or wakes up, so a
 *   background window catches up without replaying an unbounded op log.
 * - Undo is per-window and selective: it only reverts records that still hold
 *   this window's own value, so later changes by other windows survive.
 * - Export reads an explicitly committed snapshot, taken after each applied
 *   batch and never mid-drag.
 */
import { computed, reactive, ref } from "vue";
import { doc } from "../../../shared/document";
import type { Shape } from "../../../shared/types";
import {
  applyOps,
  cloneNode,
  cloneState,
  compact,
  defaultFieldValue,
  emptyState,
  eqClock,
  fieldValue,
  ownedBy,
  materialize,
  maxClock,
  mergeState,
  nodeKey,
  shapeRecords,
  type Clock,
  type DocState,
  type Field,
  type Materialized,
  type MaterializedShape,
  type NodeLite,
  type Op,
  type OpInput,
  type ShapeRec,
} from "./crdt";
import { seedShapes } from "../../drawing/model/seed";
import { colorFor } from "./colors";

const STORAGE_KEY = "forma-collab-doc-v2";
const LEGACY_KEY = "forma-document";
const DOC_ID = "bloom-artboard-01";
const CONTROL = "forma-collab-control-v1";
const PING_MS = 1200;
const PEER_TTL_MS = 4200;
const TXN_IDLE_MS = 450;
const HISTORY_LIMIT = 60;

export const writerId = crypto.randomUUID();
export const selfName = `窗口 ${writerId.slice(0, 4).toUpperCase()}`;
export const selfColor = colorFor(writerId);

export interface Peer {
  id: string;
  name: string;
  color: string;
}
export interface Notice {
  id: number;
  text: string;
  tone: "info" | "warn";
}

export const peerList = ref<Peer[]>([]);
export const notices = reactive<Notice[]>([]);
/** Bumped on every locally or remotely applied change (reactive view). */
export const revision = ref(0);
/** Bumped only when an applied batch becomes the exportable snapshot. */
export const committedRevision = ref(0);
export const sync = reactive({ pending: 0, catching: false });

export const syncLabel = computed(() => {
  if (sync.catching) return "正在获取最新状态…";
  if (sync.pending > 0) return "正在同步修改…";
  if (peerList.value.length > 0)
    return `已同步 · ${peerList.value.length} 个协作窗口`;
  return "已保存到本机 · 暂无其他窗口";
});
export const syncHealthy = computed(() => !sync.catching && sync.pending === 0);

let docId = DOC_ID;
let generation = 1;
let state: DocState = emptyState([1, writerId]);
let lamport = 1;
let committed: Materialized = { shapes: [], nodes: {} };
let committedSeq = 0;
let channel: BroadcastChannel | null = null;
let control: BroadcastChannel | null = null;
const peers = new Map<string, Peer & { lastSeen: number }>();
const pendingAcks = new Map<number, Set<string>>();
const ackTimers = new Map<number, ReturnType<typeof setTimeout>>();
let outSeq = 0;
let initialized = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let noticeSeq = 0;
const noticeSeen = new Map<string, number>();
const heartbeat = { timer: null as ReturnType<typeof setInterval> | null };

function epochName() {
  return `${docId}#${generation}`;
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

export function notice(text: string, tone: Notice["tone"] = "info") {
  const now = Date.now();
  for (const [key, at] of noticeSeen)
    if (now - at > 4000) noticeSeen.delete(key);
  if (noticeSeen.has(text)) return;
  noticeSeen.set(text, now);
  const id = ++noticeSeq;
  notices.push({ id, text, tone });
  setTimeout(() => {
    const i = notices.findIndex((n) => n.id === id);
    if (i >= 0) notices.splice(i, 1);
  }, 6000);
  if (notices.length > 4) notices.splice(0, notices.length - 4);
}

/* ------------------------------------------------------------------ */
/* Mirrors                                                             */
/* ------------------------------------------------------------------ */

/** Replace the editable mirror and commit a new exportable snapshot. */
function installMirror() {
  const m = materialize(state);
  committed = m;
  committedSeq = ++committedRevision.value;
  /* the mirror is a deep copy: a drag preview must not leak into exports */
  doc.shapes = m.shapes.map((s) => ({
    ...s,
    nodes: s.nodes.map(cloneNode),
  })) as unknown as Shape[];
  const alive = new Set(m.shapes.map((s) => s.id));
  const kept = doc.selected.filter((id) => alive.has(id));
  if (kept.length !== doc.selected.length) doc.selected = kept;
  revision.value++;
}

export function exportSnapshot() {
  return {
    revision: committedSeq,
    shapes: committed.shapes,
    nodes: committed.nodes,
  };
}

export function findNode(
  shapeId: string,
  nodeId: string,
): NodeLite | undefined {
  return committed.nodes[nodeKey(shapeId, nodeId)];
}

/** The mutable mirror node (what the canvas is currently drawing). */
export function mirrorNode(shapeId: string, nodeId: string) {
  const shape = doc.shapes.find((s) => s.id === shapeId);
  return shape?.nodes.find((n) => n.id === nodeId);
}

/* ------------------------------------------------------------------ */
/* Channel plumbing                                                    */
/* ------------------------------------------------------------------ */

type Msg =
  | { t: "hello"; docId: string; gen: number; from: string }
  | {
      t: "snap";
      docId: string;
      gen: number;
      from: string;
      to?: string;
      state: DocState;
    }
  | {
      t: "ops";
      docId: string;
      gen: number;
      from: string;
      seq: number;
      ops: Op[];
    }
  | {
      t: "ack";
      docId: string;
      gen: number;
      from: string;
      to: string;
      seq: number;
    }
  | {
      t: "presence";
      docId: string;
      gen: number;
      from: string;
      name: string;
      color: string;
    }
  | { t: "bye"; docId: string; gen: number; from: string };

type ControlMsg = {
  t: "reopen";
  docId: string;
  gen: number;
  from: string;
  state: DocState;
};

function post(msg: Msg) {
  try {
    channel?.postMessage(msg);
  } catch {
    /* channel closed during a document switch: late events are dropped */
  }
}

function openChannel() {
  channel?.close();
  channel = new BroadcastChannel(`forma-collab:${docId}:${generation}`);
  channel.onmessage = onMessage;
}

function hello() {
  if (!channel) return;
  /* only claim we are catching up when somebody can answer */
  if (peers.size > 0) {
    sync.catching = true;
    setTimeout(() => {
      sync.catching = false;
    }, 900);
  }
  post({ t: "hello", docId, gen: generation, from: writerId });
}

function sendPresence() {
  post({
    t: "presence",
    docId,
    gen: generation,
    from: writerId,
    name: selfName,
    color: selfColor,
  });
}

function refreshPeers() {
  peerList.value = [...peers.values()]
    .filter((p) => Date.now() - p.lastSeen < PEER_TTL_MS)
    .map(({ id, name, color }) => ({ id, name, color }));
}

/* ------------------------------------------------------------------ */
/* Applying remote work                                                */
/* ------------------------------------------------------------------ */

function snapshotMessage(to?: string): Msg {
  return {
    t: "snap",
    docId,
    gen: generation,
    from: writerId,
    to,
    state: compact(state),
  };
}

function receiveSnapshot(msg: Extract<Msg, { t: "snap" }>) {
  if (msg.to && msg.to !== writerId) return;
  const before = materialize(state);
  const { changed } = mergeState(state, msg.state);
  lamport = Math.max(lamport, maxClock(state)[0]);
  sync.catching = false;
  if (!changed) return;
  installMirror();
  saveSoon();
  const after = new Set(materialize(state).shapes.map((s) => s.id));
  for (const shape of before.shapes) {
    if (!after.has(shape.id))
      notice(`「${shape.name}」已被另一窗口删除`, "warn");
  }
}

function receiveOps(msg: Extract<Msg, { t: "ops" }>) {
  const names = new Map<string, string>();
  for (const rec of Object.values(state.shapes))
    names.set(rec.id, fieldValue<string>(rec, "name"));
  const report = applyOps(state, msg.ops, writerId);
  lamport = Math.max(lamport, maxClock(state)[0]);
  if (report.changed) {
    installMirror();
    saveSoon();
    explain(report, names);
  }
  post({
    t: "ack",
    docId,
    gen: generation,
    from: writerId,
    to: msg.from,
    seq: msg.seq,
  });
}

function explain(
  report: ReturnType<typeof applyOps>,
  names: Map<string, string>,
) {
  for (const id of new Set(report.deleted))
    notice(`「${names.get(id) ?? "对象"}」已被另一窗口删除`, "warn");
  for (const id of new Set(report.rejected))
    notice(
      `「${names.get(id) ?? "对象"}」已被删除，另一窗口的改动被忽略`,
      "warn",
    );
  for (const c of report.conflicts) {
    const name = c.shapeId ? (names.get(c.shapeId) ?? "对象") : "文档";
    const what = c.field
      ? `的${fieldLabel(c.field)}`
      : c.nodeKey
        ? "的同一锚点"
        : "";
    if (c.winner === "remote")
      notice(`另一窗口同时改了「${name}」${what}，已采用较新的修改`, "warn");
    else
      notice(
        `你的「${name}」${what}改动已保留，另一窗口的同时改动被覆盖`,
        "info",
      );
  }
}

function fieldLabel(field: Field) {
  return (
    {
      name: "名称",
      closed: "闭合状态",
      fill: "填充",
      stroke: "描边",
      width: "线宽",
      opacity: "不透明度",
      group: "分组",
    } as Record<Field, string>
  )[field];
}

/* ------------------------------------------------------------------ */
/* Local editing                                                       */
/* ------------------------------------------------------------------ */

type Snapshot<T> = { present: boolean; value: T };
type Step =
  | {
      kind: "field";
      shapeId: string;
      field: Field;
      before: Snapshot<unknown>;
      after: Snapshot<unknown>;
      expect: Clock;
    }
  | {
      kind: "node";
      shapeId: string;
      nodeId: string;
      before: Snapshot<NodeLite>;
      after: Snapshot<NodeLite>;
      expect: Clock;
    }
  | {
      kind: "del";
      shapeId: string;
      before: boolean;
      after: boolean;
      expect: Clock;
      /** Creation steps carry no pre-edit register; compare the whole record. */
      untouched?: boolean;
    }
  | { kind: "order"; before: string[]; after: string[]; expect: Clock };

interface Entry {
  steps: Step[];
}

const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
let txn: Map<string, Step> | null = null;
let txnTimer: ReturnType<typeof setTimeout> | null = null;
let txnCreated = new Set<string>();
/** True while undo/redo replays a recorded step: never record it again. */
let replaying = false;

export function beginEdit() {
  endEdit();
  txn = new Map();
  txnCreated = new Set();
}

function ensureTxn() {
  if (!txn) {
    txn = new Map();
    txnCreated = new Set();
  }
  ensureTxnIdle();
}

function ensureTxnIdle() {
  if (txnTimer) clearTimeout(txnTimer);
  txnTimer = setTimeout(endEdit, TXN_IDLE_MS);
}

/** Close the current atomic edit batch and push it onto the undo stack. */
export function endEdit() {
  if (txnTimer) {
    clearTimeout(txnTimer);
    txnTimer = null;
  }
  if (txn && txn.size) {
    undoStack.push({ steps: [...txn.values()] });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  txn = null;
  txnCreated = new Set();
}

function nextClock(): Clock {
  lamport = Math.max(lamport, maxClock(state)[0]) + 1;
  return [lamport, writerId];
}

function toOp(input: OpInput, c: Clock): Op {
  switch (input.kind) {
    case "field": {
      const rec = state.shapes[input.shapeId];
      return {
        kind: "field",
        shapeId: input.shapeId,
        field: input.field,
        v: structuredClone(input.v),
        c,
        base: rec?.f[input.field]?.c,
      };
    }
    case "node": {
      const key = nodeKey(input.shapeId, input.node.id);
      const rec = state.nodes[key];
      return {
        kind: "node",
        shapeId: input.shapeId,
        key,
        node: cloneNode(input.node),
        seq: rec ? rec.seq : state.seq++,
        c,
        ...(input.del !== undefined ? { del: input.del } : {}),
        base: rec?.c,
      };
    }
    case "del":
      return {
        kind: "del",
        shapeId: input.shapeId,
        v: input.v,
        c,
        base: state.shapes[input.shapeId]?.del?.c,
      };
    case "order":
      return { kind: "order", ids: [...input.ids], c, base: state.order.c };
  }
}

/** Record what this edit changed, for this window's selective undo. */
function recordStep(input: OpInput, c: Clock) {
  if (!txn || replaying) return;
  const put = (key: string, step: Step) => {
    const existing = txn!.get(key) as Step | undefined;
    if (!existing) {
      txn!.set(key, step);
      return;
    }
    existing.after = step.after as never;
    existing.expect = c;
  };
  switch (input.kind) {
    case "field": {
      if (txnCreated.has(input.shapeId)) return;
      const rec = state.shapes[input.shapeId];
      if (!rec) {
        txnCreated.add(input.shapeId);
        txn.set(`d:${input.shapeId}`, {
          kind: "del",
          shapeId: input.shapeId,
          before: true,
          after: false,
          expect: c,
          untouched: true,
        });
        return;
      }
      put(`f:${input.shapeId}:${input.field}`, {
        kind: "field",
        shapeId: input.shapeId,
        field: input.field,
        before: {
          present: !!rec.f[input.field],
          value: fieldValue(rec, input.field),
        },
        after: { present: true, value: structuredClone(input.v) },
        expect: c,
      });
      return;
    }
    case "node": {
      if (txnCreated.has(input.shapeId)) return;
      const key = nodeKey(input.shapeId, input.node.id);
      const rec = state.nodes[key];
      put(`n:${key}`, {
        kind: "node",
        shapeId: input.shapeId,
        nodeId: input.node.id,
        before: rec
          ? { present: true, value: cloneNode(rec.node) }
          : { present: false, value: cloneNode(input.node) },
        after: { present: input.del !== true, value: cloneNode(input.node) },
        expect: c,
      });
      return;
    }
    case "del": {
      const rec = state.shapes[input.shapeId];
      put(`d:${input.shapeId}`, {
        kind: "del",
        shapeId: input.shapeId,
        before: rec?.del?.v === true,
        after: input.v,
        expect: c,
      });
      return;
    }
    case "order":
      put("o", {
        kind: "order",
        before: [...state.order.v],
        after: [...input.ids],
        expect: c,
      });
      return;
  }
}

function broadcastOps(ops: Op[]) {
  const targets = new Set(peers.keys());
  const seq = ++outSeq;
  if (targets.size > 0) {
    pendingAcks.set(seq, targets);
    sync.pending = pendingAcks.size;
    const timer = setTimeout(() => {
      pendingAcks.delete(seq);
      ackTimers.delete(seq);
      sync.pending = pendingAcks.size;
    }, 2500);
    ackTimers.set(seq, timer);
  }
  post({ t: "ops", docId, gen: generation, from: writerId, seq, ops });
}

function submit(inputs: OpInput[]) {
  ensureTxn();
  const ops: Op[] = [];
  for (const input of inputs) {
    const c = nextClock();
    recordStep(input, c);
    ops.push(toOp(input, c));
  }
  const report = applyOps(state, ops, writerId);
  if (!report.changed) {
    if (report.rejected.length)
      notice("该对象已被另一窗口删除，本次修改未应用", "warn");
    return report;
  }
  installMirror();
  broadcastOps(ops);
  saveSoon();
  if (report.rejected.length)
    notice("部分对象已被另一窗口删除，相关修改未应用", "warn");
  return report;
}

/* ------------------------------------------------------------------ */
/* Edit API used by feature modules                                    */
/* ------------------------------------------------------------------ */

export type ShapeDraft = MaterializedShape;

export function createShape(shape: ShapeDraft) {
  const c: Clock = nextClock();
  ensureTxn();
  txnCreated.add(shape.id);
  txn!.set(`d:${shape.id}`, {
    kind: "del",
    shapeId: shape.id,
    before: true,
    after: false,
    expect: c,
    untouched: true,
  });
  const { shape: rec, nodes, seq } = shapeRecords(shape, c, state.seq);
  state.shapes[shape.id] = rec;
  for (const node of nodes)
    state.nodes[nodeKey(node.shapeId, node.node.id)] = node;
  state.seq = seq;
  /* order is built from the visible list so layers created concurrently in
     another window are not dropped by the next ordering write */
  const order = materialize(state).shapes.map((s) => s.id);
  state.order = { v: order, c };
  installMirror();
  doc.selected = [shape.id];
  broadcastOps([
    ...creationOps(rec, nodes, c),
    { kind: "order", ids: order, c },
  ]);
  saveSoon();
}

function creationOps(
  rec: ShapeRec,
  nodes: ReturnType<typeof shapeRecords>["nodes"],
  c: Clock,
): Op[] {
  const ops: Op[] = [];
  for (const field of Object.keys(rec.f) as Field[])
    ops.push({
      kind: "field",
      shapeId: rec.id,
      field,
      v: structuredClone(rec.f[field]!.v),
      c,
    });
  for (const node of nodes)
    ops.push({
      kind: "node",
      shapeId: node.shapeId,
      key: nodeKey(node.shapeId, node.node.id),
      node: cloneNode(node.node),
      seq: node.seq,
      c,
    });
  return ops;
}

/** Append an anchor to a path (pen tool). */
export function addNode(shapeId: string, node: NodeLite) {
  submit([{ kind: "node", shapeId, node }]);
}

/** Write one anchor's final geometry after a drag. */
export function writeNode(shapeId: string, node: NodeLite) {
  submit([{ kind: "node", shapeId, node }]);
}

/** Write a whole selection's anchors as one delta (a finished layer drag). */
export function writeNodes(entries: { shapeId: string; node: NodeLite }[]) {
  submit(entries.map(({ shapeId, node }) => ({ kind: "node", shapeId, node })));
}

export function setFields(shapeIds: string[], field: Field, value: unknown) {
  submit(
    shapeIds.map((shapeId) => ({ kind: "field", shapeId, field, v: value })),
  );
}

export function reorderShapes(ids: string[]) {
  submit([{ kind: "order", ids }]);
}

export function deleteShapes(ids: string[]) {
  submit(ids.map((shapeId) => ({ kind: "del", shapeId, v: true })));
}

/* ------------------------------------------------------------------ */
/* Selective undo                                                      */
/* ------------------------------------------------------------------ */

function currentClock(step: Step): Clock | undefined {
  switch (step.kind) {
    case "field":
      return state.shapes[step.shapeId]?.f[step.field]?.c;
    case "node":
      return state.nodes[nodeKey(step.shapeId, step.nodeId)]?.c;
    case "del":
      return state.shapes[step.shapeId]?.del?.c;
    case "order":
      return state.order.c;
  }
}

/**
 * A step may be reverted only while the record still holds the value this
 * window wrote. If another window has written since, its change is preserved.
 */
function safe(step: Step): boolean {
  /* Undoing the creation of a layer removes it entirely, but only while no
     other window has touched it since. */
  if (step.kind === "del" && step.untouched)
    return ownedBy(state, step.shapeId, writerId);
  return eqClock(currentClock(step), step.expect);
}

/** Build the write that restores one side of a recorded step. */
function stepInput(step: Step, side: "before" | "after"): OpInput {
  if (step.kind === "field") {
    const target = step[side];
    return {
      kind: "field",
      shapeId: step.shapeId,
      field: step.field,
      v: target.present
        ? structuredClone(target.value)
        : defaultFieldValue(step.field),
    };
  }
  if (step.kind === "node") {
    const target = step[side];
    return {
      kind: "node",
      shapeId: step.shapeId,
      node: { ...cloneNode(target.value), id: step.nodeId },
      del: !target.present,
    };
  }
  if (step.kind === "del")
    return { kind: "del", shapeId: step.shapeId, v: step[side] };
  return { kind: "order", ids: step[side] };
}

/**
 * Replay recorded steps: "back" restores each `before`, "forward" restores
 * each `after`. The returned steps keep their before/after values and only
 * update `expect` to the clock just written, so the same entry can then be
 * replayed in the opposite direction and stays safe under `safe()`.
 */
function applySteps(steps: Step[], direction: "back" | "forward"): Step[] {
  ensureTxn();
  const side = direction === "back" ? "before" : "after";
  const inputs = steps.map((step) => stepInput(step, side));
  const ops = inputs.map((input) => toOp(input, nextClock()));
  const clocks = ops.map((op) => op.c);
  replaying = true;
  const report = applyOps(state, ops, writerId);
  replaying = false;
  if (report.changed) {
    installMirror();
    broadcastOps(ops);
    saveSoon();
  }
  return steps.map((step, i) => ({ ...step, expect: clocks[i] }));
}

export function undo() {
  endEdit();
  const entry = undoStack.pop();
  if (!entry) {
    notice("没有可撤销的操作", "info");
    return;
  }
  const steps = [...entry.steps].reverse();
  const applied = steps.filter(safe);
  const skipped = steps.length - applied.length;
  elideUntouchedCreate(applied);
  if (applied.length) {
    redoStack.push({ steps: applySteps(applied, "back") });
    if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
  }
  if (skipped)
    notice("其他窗口已更新这部分内容，撤销只回退了仍属于你的改动", "warn");
  else if (applied.length) notice("已撤销上一步，其他人的修改保持不变", "info");
  endEdit();
}

export function redo() {
  endEdit();
  const entry = redoStack.pop();
  if (!entry) {
    notice("没有可重做的操作", "info");
    return;
  }
  const applied = entry.steps.filter(safe);
  const skipped = entry.steps.length - applied.length;
  if (applied.length) {
    undoStack.push({ steps: applySteps(applied, "forward") });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  }
  if (skipped) notice("部分内容已被其他窗口更新，重做未能全部应用", "warn");
  endEdit();
}

/** A just-created layer should vanish entirely rather than lose fields. */
function elideUntouchedCreate(steps: Step[]) {
  const created = steps.filter(
    (s): s is Extract<Step, { kind: "del" }> =>
      s.kind === "del" && s.untouched === true && s.before === true,
  );
  for (const c of created) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if ((s.kind === "field" || s.kind === "node") && s.shapeId === c.shapeId)
        steps.splice(i, 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

interface SavedSnapshot {
  docId: string;
  gen: number;
  state: DocState;
}

function validShape(s: Shape) {
  return (
    s &&
    typeof s.id === "string" &&
    Array.isArray(s.nodes) &&
    s.nodes.every(
      (n) =>
        Number.isFinite(n.x) &&
        Number.isFinite(n.y) &&
        Number.isFinite(n.in?.x) &&
        Number.isFinite(n.in?.y) &&
        Number.isFinite(n.out?.x) &&
        Number.isFinite(n.out?.y),
    )
  );
}

export function loadSnapshot(): SavedSnapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (
      value &&
      typeof value.docId === "string" &&
      typeof value.gen === "number" &&
      value.state &&
      typeof value.state === "object"
    )
      return value as SavedSnapshot;
  } catch {
    /* fall through */
  }
  return null;
}

/** Import v1 local documents (nodes without ids) into the shared model. */
function importLegacy(): DocState | null {
  try {
    const shapes = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    if (!Array.isArray(shapes) || !shapes.every(validShape)) return null;
    const clock: Clock = [1, "legacy"];
    const next = emptyState(clock);
    for (const shape of shapes as Shape[]) {
      const materialized: MaterializedShape = {
        id: shape.id,
        name: shape.name || "Layer",
        nodes: shape.nodes.map((n, i) => ({
          id: `${shape.id}:n${i}`,
          x: n.x,
          y: n.y,
          in: { x: n.in.x, y: n.in.y },
          out: { x: n.out.x, y: n.out.y },
        })),
        closed: !!shape.closed,
        fill: shape.fill || "none",
        stroke: shape.stroke || "#7754dc",
        width: Number.isFinite(shape.width) ? shape.width : 3,
        opacity: Number.isFinite(shape.opacity) ? shape.opacity : 1,
        ...(shape.group ? { group: shape.group } : {}),
      };
      const {
        shape: rec,
        nodes,
        seq,
      } = shapeRecords(materialized, clock, next.seq);
      next.shapes[rec.id] = rec;
      for (const node of nodes)
        next.nodes[nodeKey(node.shapeId, node.node.id)] = node;
      next.seq = seq;
      next.order.v.push(rec.id);
    }
    return next;
  } catch {
    return null;
  }
}

export function save() {
  try {
    const payload: SavedSnapshot = {
      docId,
      gen: generation,
      state: compact(state),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    notice("本机存储不可用 —— 请导出以保留作品", "warn");
  }
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 220);
}

/* ------------------------------------------------------------------ */
/* Document lifecycle                                                  */
/* ------------------------------------------------------------------ */

function seedLocal() {
  const c: Clock = [1, "seed"];
  for (const shape of seedShapes()) {
    const { shape: rec, nodes, seq } = shapeRecords(shape, c, state.seq);
    state.shapes[rec.id] = rec;
    for (const node of nodes)
      state.nodes[nodeKey(node.shapeId, node.node.id)] = node;
    state.seq = seq;
    state.order.v.push(rec.id);
  }
  state.order.c = c;
  lamport = 2;
}

function clearPeerBookkeeping() {
  peers.clear();
  peerList.value = [];
  pendingAcks.clear();
  for (const timer of ackTimers.values()) clearTimeout(timer);
  ackTimers.clear();
  sync.pending = 0;
  sync.catching = false;
}

function adopt(nextDocId: string, nextGen: number, nextState: DocState) {
  channel?.close();
  channel = null;
  docId = nextDocId;
  generation = nextGen;
  state = cloneState(nextState);
  lamport = Math.max(lamport, maxClock(state)[0]);
  undoStack.length = 0;
  redoStack.length = 0;
  txn = null;
  if (txnTimer) {
    clearTimeout(txnTimer);
    txnTimer = null;
  }
  clearPeerBookkeeping();
  doc.selected = [];
  installMirror();
  openChannel();
  hello();
  sendPresence();
  saveSoon();
}

export function initSession() {
  if (initialized) return;
  initialized = true;
  const saved = loadSnapshot();
  if (saved) {
    docId = saved.docId;
    generation = saved.gen;
    state = cloneState(saved.state);
  } else {
    const legacy = importLegacy();
    if (legacy) state = legacy;
    else {
      seedLocal();
    }
  }
  lamport = Math.max(1, maxClock(state)[0]);
  control = new BroadcastChannel(CONTROL);
  control.onmessage = onControl;
  openChannel();
  installMirror();
  hello();
  sendPresence();
  heartbeat.timer = setInterval(sendPresence, PING_MS);
  setInterval(refreshPeers, 1500);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("beforeunload", () => {
    post({ t: "bye", docId, gen: generation, from: writerId });
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      save();
    }
    control?.close();
  });
  if (doc.selected.length === 0 && doc.shapes.length)
    doc.selected = [doc.shapes[Math.min(3, doc.shapes.length - 1)].id];
}

/** A background window that wakes up asks peers for one compact snapshot. */
function onVisible() {
  if (document.visibilityState !== "visible") return;
  hello();
  sendPresence();
}

/**
 * Reload the persisted document as a new generation. Late messages from the
 * previous generation fail the channel + generation check, so they can never
 * leak into the reopened document.
 */
export function restore() {
  const saved = loadSnapshot();
  if (!saved) {
    notice("本机没有可恢复的版本", "warn");
    return false;
  }
  generation = Math.max(generation, saved.gen) + 1;
  adopt(saved.docId, generation, saved.state);
  save();
  control?.postMessage({
    t: "reopen",
    docId,
    gen: generation,
    from: writerId,
    state: compact(state),
  } satisfies ControlMsg);
  notice("已重新载入本机保存的版本", "info");
  return true;
}

function onControl(ev: MessageEvent<ControlMsg>) {
  const msg = ev.data;
  if (!msg || msg.t !== "reopen") return;
  if (msg.docId !== docId || msg.gen <= generation) return;
  adopt(msg.docId, msg.gen, msg.state);
  notice("其他窗口重新载入了文档，已切换到同一版本", "warn");
}

/* ------------------------------------------------------------------ */
/* Incoming messages                                                   */
/* ------------------------------------------------------------------ */

function onMessage(ev: MessageEvent<Msg>) {
  const msg = ev.data;
  if (!msg || msg.docId !== docId || msg.gen !== generation) return;
  if (msg.from === writerId) return;
  switch (msg.t) {
    case "hello": {
      sendPresence();
      const delay = 30 + Math.floor(Math.random() * 120);
      setTimeout(() => {
        if (msg.gen === generation) post(snapshotMessage(msg.from));
      }, delay);
      return;
    }
    case "snap":
      receiveSnapshot(msg);
      return;
    case "ops":
      receiveOps(msg);
      return;
    case "ack": {
      if (msg.to !== writerId) return;
      const set = pendingAcks.get(msg.seq);
      set?.delete(msg.from);
      if (set && set.size === 0) {
        pendingAcks.delete(msg.seq);
        const timer = ackTimers.get(msg.seq);
        if (timer) clearTimeout(timer);
        ackTimers.delete(msg.seq);
        sync.pending = pendingAcks.size;
      }
      return;
    }
    case "presence": {
      const known = peers.has(msg.from);
      peers.set(msg.from, {
        id: msg.from,
        name: msg.name,
        color: msg.color,
        lastSeen: Date.now(),
      });
      refreshPeers();
      /* a peer we just met may hold edits we missed */
      if (!known) hello();
      return;
    }
    case "bye": {
      peers.delete(msg.from);
      refreshPeers();
      for (const [seq, set] of pendingAcks) {
        set.delete(msg.from);
        if (set.size === 0) {
          pendingAcks.delete(seq);
          const timer = ackTimers.get(seq);
          if (timer) clearTimeout(timer);
          ackTimers.delete(seq);
        }
      }
      sync.pending = pendingAcks.size;
      return;
    }
  }
}
