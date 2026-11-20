/**
 * Shared-document model for same-machine, server-less multi-window editing.
 *
 * Every editable property is a last-writer-wins register stamped with a Lamport
 * clock `[counter, writerId]`: one register per style field and one per path
 * anchor. Two windows editing different properties — or different anchors —
 * therefore merge without clobbering each other.
 *
 * Deletions are tombstones and always hide their object. A write aimed at a
 * tombstoned layer is rejected, which gives a deterministic outcome for
 * "one window moves it while another deletes it".
 *
 * Nothing here sends whole documents on edits and nothing keeps an operation
 * log: peers exchange tiny per-record operations, and a re-joining window asks
 * for one compact state snapshot.
 */
import type { Point } from "../../../shared/types";

export type Clock = [number, string];
export interface Reg<T> {
  v: T;
  c: Clock;
}
export interface NodeLite {
  id: string;
  x: number;
  y: number;
  in: Point;
  out: Point;
}

export const FIELDS = [
  "name",
  "closed",
  "fill",
  "stroke",
  "width",
  "opacity",
  "group",
] as const;
export type Field = (typeof FIELDS)[number];

export interface ShapeRec {
  id: string;
  created: Clock;
  f: Partial<Record<Field, Reg<unknown>>>;
  /** `v: true` means the layer is deleted. */
  del?: Reg<boolean>;
}
export interface NodeRec {
  shapeId: string;
  node: NodeLite;
  seq: number;
  c: Clock;
  /** `v: true` means the anchor was removed. */
  del?: Reg<boolean>;
}
export interface DocState {
  order: Reg<string[]>;
  shapes: Record<string, ShapeRec>;
  nodes: Record<string, NodeRec>;
  /** Monotonic counter used to order anchors inside a path. */
  seq: number;
}

export interface FieldOp {
  kind: "field";
  shapeId: string;
  field: Field;
  v: unknown;
  c: Clock;
  /** Clock the author had observed for this register when editing. */
  base?: Clock;
}
export interface NodeOp {
  kind: "node";
  shapeId: string;
  key: string;
  node: NodeLite;
  seq: number;
  c: Clock;
  /** Present only when this op also writes the anchor tombstone register. */
  del?: boolean;
  base?: Clock;
}
export interface DelOp {
  kind: "del";
  shapeId: string;
  v: boolean;
  c: Clock;
  base?: Clock;
}
export interface OrderOp {
  kind: "order";
  ids: string[];
  c: Clock;
  base?: Clock;
}
export type Op = FieldOp | NodeOp | DelOp | OrderOp;

/** Ops authored locally, before the session stamps them with clocks. */
export type OpInput =
  | { kind: "field"; shapeId: string; field: Field; v: unknown }
  | { kind: "node"; shapeId: string; node: NodeLite; del?: boolean }
  | { kind: "del"; shapeId: string; v: boolean }
  | { kind: "order"; ids: string[] };

export interface Conflict {
  shapeId?: string;
  nodeKey?: string;
  field?: Field;
  /** Who kept the value: the remote write or the local one. */
  winner: "remote" | "local";
  writer: string;
}
export interface ApplyReport {
  changed: boolean;
  conflicts: Conflict[];
  /** Writes dropped because their object was already gone. */
  rejected: string[];
  deleted: string[];
}

export function eqClock(a?: Clock, b?: Clock): boolean {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}
export function cmpClock(a: Clock, b: Clock): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1;
}
export function wins(c: Clock, current?: Clock): boolean {
  return !current || cmpClock(c, current) > 0;
}
export function maxClock(state: DocState): Clock {
  let max: Clock = [1, ""];
  const see = (c?: Clock) => {
    if (c && c[0] > max[0]) max = [c[0], c[1]];
  };
  see(state.order.c);
  for (const rec of Object.values(state.shapes)) {
    see(rec.created);
    see(rec.del?.c);
    for (const field of FIELDS) see(rec.f[field]?.c);
  }
  for (const rec of Object.values(state.nodes)) {
    see(rec.c);
    see(rec.del?.c);
  }
  return max;
}

export function nodeKey(shapeId: string, nodeId: string): string {
  return `${shapeId}\u0000${nodeId}`;
}
export function clonePoint(p: Point): Point {
  return { x: p.x, y: p.y };
}
export function cloneNode(n: NodeLite): NodeLite {
  return {
    id: n.id,
    x: n.x,
    y: n.y,
    in: clonePoint(n.in),
    out: clonePoint(n.out),
  };
}
export function cloneReg<T>(r: Reg<T>): Reg<T> {
  return { v: structuredClone(r.v), c: [r.c[0], r.c[1]] };
}
export function cloneNodeRec(r: NodeRec): NodeRec {
  return {
    shapeId: r.shapeId,
    node: cloneNode(r.node),
    seq: r.seq,
    c: [r.c[0], r.c[1]],
    ...(r.del ? { del: cloneReg(r.del) } : {}),
  };
}

export function emptyState(clock: Clock): DocState {
  return {
    order: { v: [], c: [clock[0], clock[1]] },
    shapes: {},
    nodes: {},
    seq: 1,
  };
}

export function cloneState(s: DocState): DocState {
  return {
    order: cloneReg(s.order),
    shapes: Object.fromEntries(
      Object.entries(s.shapes).map(([id, rec]) => [
        id,
        {
          id: rec.id,
          created: [rec.created[0], rec.created[1]] as Clock,
          f: Object.fromEntries(
            Object.entries(rec.f).map(([k, v]) => [k, cloneReg(v!)]),
          ) as ShapeRec["f"],
          ...(rec.del ? { del: cloneReg(rec.del) } : {}),
        },
      ]),
    ),
    nodes: Object.fromEntries(
      Object.entries(s.nodes).map(([k, rec]) => [k, cloneNodeRec(rec)]),
    ),
    seq: s.seq,
  };
}

/** The visible document derived from CRDT records. */
export interface MaterializedShape {
  id: string;
  name: string;
  nodes: NodeLite[];
  closed: boolean;
  fill: string;
  stroke: string;
  width: number;
  opacity: number;
  group?: string;
}
export interface Materialized {
  shapes: MaterializedShape[];
  nodes: Record<string, NodeLite>;
}

const DEFAULTS: Record<Field, unknown> = {
  name: "Pen path",
  closed: false,
  fill: "none",
  stroke: "#7754dc",
  width: 3,
  opacity: 1,
  group: undefined,
};

export function fieldValue<T = unknown>(rec: ShapeRec, field: Field): T {
  const reg = rec.f[field];
  return (reg ? reg.v : DEFAULTS[field]) as T;
}
export function defaultFieldValue(field: Field): unknown {
  return DEFAULTS[field];
}
export function isDeleted(rec: ShapeRec | undefined): boolean {
  return !rec || rec.del?.v === true;
}
export function isNodeVisible(rec: NodeRec): boolean {
  return rec.del?.v !== true;
}

/**
 * True when every recorded write to a layer came from `writer`. Used to decide
 * whether this window still owns a layer it created, i.e. whether undoing the
 * creation is safe.
 */
export function ownedBy(state: DocState, shapeId: string, writer: string) {
  const rec = state.shapes[shapeId];
  if (!rec) return true;
  const clocks: (Clock | undefined)[] = [rec.created, rec.del?.c];
  for (const field of FIELDS) clocks.push(rec.f[field]?.c);
  for (const node of Object.values(state.nodes))
    if (node.shapeId === shapeId) clocks.push(node.c, node.del?.c);
  return clocks.every((c) => !c || c[1] === writer);
}

/**
 * Project CRDT records into the ordered shape list + node lookup consumed by
 * the UI. Tombstones disappear; layers created concurrently but missing from
 * the shared order are appended by creation clock.
 */
export function materialize(state: DocState): Materialized {
  const nodes: Record<string, NodeLite> = {};
  const byShape = new Map<string, NodeRec[]>();
  for (const rec of Object.values(state.nodes)) {
    if (!isNodeVisible(rec)) continue;
    const list = byShape.get(rec.shapeId) ?? [];
    list.push(rec);
    byShape.set(rec.shapeId, list);
  }
  const alive = Object.values(state.shapes).filter((r) => !isDeleted(r));
  const byId = new Map(alive.map((r) => [r.id, r]));
  const ordered: ShapeRec[] = [];
  const seen = new Set<string>();
  for (const id of state.order.v) {
    const rec = byId.get(id);
    if (rec && !seen.has(id)) {
      seen.add(id);
      ordered.push(rec);
    }
  }
  ordered.push(
    ...alive
      .filter((r) => !seen.has(r.id))
      .sort((a, b) => cmpClock(a.created, b.created)),
  );
  const shapes: MaterializedShape[] = ordered.map((rec) => {
    const shape: MaterializedShape = {
      id: rec.id,
      name: fieldValue<string>(rec, "name"),
      nodes: (byShape.get(rec.id) ?? [])
        .sort((a, b) =>
          a.seq !== b.seq ? a.seq - b.seq : a.node.id < b.node.id ? -1 : 1,
        )
        .map((n) => {
          const node = cloneNode(n.node);
          nodes[nodeKey(rec.id, node.id)] = node;
          return node;
        }),
      closed: fieldValue<boolean>(rec, "closed"),
      fill: fieldValue<string>(rec, "fill"),
      stroke: fieldValue<string>(rec, "stroke"),
      width: fieldValue<number>(rec, "width"),
      opacity: fieldValue<number>(rec, "opacity"),
    };
    const group = fieldValue<string | undefined>(rec, "group");
    if (group) shape.group = group;
    return shape;
  });
  return { shapes, nodes };
}

function noteConflict(
  report: ApplyReport,
  localWriter: string | undefined,
  op: { shapeId?: string; c: Clock; base?: Clock; field?: Field; key?: string },
  current: Clock | undefined,
  remoteWins: boolean,
) {
  if (!localWriter) return;
  if (!op.base || !current) return;
  if (op.c[1] === localWriter) return;
  /* only interesting when the register was changed locally since the author
     looked at it, i.e. a genuinely concurrent write */
  if (eqClock(op.base, current)) return;
  if (current[1] !== localWriter) return;
  report.conflicts.push({
    shapeId: op.shapeId,
    nodeKey: op.key,
    field: op.field,
    winner: remoteWins ? "remote" : "local",
    writer: op.c[1],
  });
}

/**
 * Merge a batch of operations into `state`. Pure: no broadcasting, no history.
 * Conflicts are only reported for concurrent writes that touch changes made by
 * `localWriter`, so the UI can explain them to the person who made them.
 */
export function applyOps(
  state: DocState,
  ops: Op[],
  localWriter?: string,
): ApplyReport {
  const report: ApplyReport = {
    changed: false,
    conflicts: [],
    rejected: [],
    deleted: [],
  };
  for (const op of ops) {
    if (op.kind === "order") {
      const current = state.order.c;
      if (!wins(op.c, current)) {
        noteConflict(report, localWriter, op, current, false);
        continue;
      }
      noteConflict(report, localWriter, op, current, true);
      const ids = op.ids.filter((id, i) => op.ids.indexOf(id) === i);
      state.order = { v: ids, c: [op.c[0], op.c[1]] };
      report.changed = true;
      continue;
    }

    const rec = state.shapes[op.shapeId];

    if (op.kind === "del") {
      const current = rec?.del?.c;
      if (rec && eqClock(op.c, current)) continue;
      if (!wins(op.c, current)) {
        noteConflict(report, localWriter, op, current, false);
        continue;
      }
      if (rec && op.v && !isDeleted(rec)) report.deleted.push(op.shapeId);
      if (!rec) {
        /* keep a tombstone for a layer we never saw, so a late creation from
           another window cannot resurrect it */
        if (!op.v) continue;
        state.shapes[op.shapeId] = {
          id: op.shapeId,
          created: [op.c[0], op.c[1]],
          f: {},
          del: { v: true, c: [op.c[0], op.c[1]] },
        };
      } else {
        rec.del = { v: op.v, c: [op.c[0], op.c[1]] };
      }
      report.changed = true;
      continue;
    }

    if (op.kind === "field") {
      if (!rec) {
        /* a field write can also be the birth of a layer on a remote peer */
        state.shapes[op.shapeId] = {
          id: op.shapeId,
          created: [op.c[0], op.c[1]],
          f: {
            [op.field]: { v: structuredClone(op.v), c: [op.c[0], op.c[1]] },
          },
        };
        report.changed = true;
        continue;
      }
      if (rec.del?.v === true) {
        report.rejected.push(op.shapeId);
        continue;
      }
      const current = rec.f[op.field]?.c;
      if (!wins(op.c, current)) {
        noteConflict(report, localWriter, op, current, false);
        continue;
      }
      noteConflict(report, localWriter, op, current, true);
      rec.f[op.field] = {
        v: structuredClone(op.v),
        c: [op.c[0], op.c[1]],
      };
      report.changed = true;
      continue;
    }

    /* node */
    if (!rec || rec.del?.v === true) {
      report.rejected.push(op.shapeId);
      continue;
    }
    const curNode = state.nodes[op.key];
    if (curNode?.del?.v === true && op.del === undefined) {
      /* moving an anchor that another window removed: keep it removed */
      report.rejected.push(op.shapeId);
      continue;
    }
    const current = curNode?.c;
    if (!wins(op.c, current)) {
      noteConflict(report, localWriter, op, current, false);
      continue;
    }
    noteConflict(report, localWriter, op, current, true);
    const next: NodeRec = {
      shapeId: op.shapeId,
      node: cloneNode(op.node),
      seq: curNode ? curNode.seq : op.seq,
      c: [op.c[0], op.c[1]],
      ...(curNode?.del ? { del: cloneReg(curNode.del) } : {}),
    };
    if (op.del !== undefined) next.del = { v: op.del, c: [op.c[0], op.c[1]] };
    state.nodes[op.key] = next;
    if (op.seq >= state.seq) state.seq = op.seq + 1;
    report.changed = true;
  }
  return report;
}

/** Merge an entire peer snapshot; only used on join/reconnect, never per edit. */
export function mergeState(
  into: DocState,
  from: DocState,
): { changed: boolean } {
  let changed = false;
  if (wins(from.order.c, into.order.c)) {
    into.order = cloneReg(from.order);
    changed = true;
  }
  for (const [id, rec] of Object.entries(from.shapes)) {
    let target = into.shapes[id];
    if (!target) {
      if (!rec.del?.v && Object.keys(rec.f).length === 0) continue;
      target = into.shapes[id] = {
        id,
        created: [rec.created[0], rec.created[1]],
        f: {},
      };
      changed = true;
    }
    if (cmpClock(rec.created, target.created) > 0) {
      target.created = [rec.created[0], rec.created[1]];
      changed = true;
    }
    if (rec.del && wins(rec.del.c, target.del?.c)) {
      target.del = cloneReg(rec.del);
      changed = true;
    }
    for (const field of FIELDS) {
      const reg = rec.f[field];
      if (reg && wins(reg.c, target.f[field]?.c)) {
        target.f[field] = cloneReg(reg);
        changed = true;
      }
    }
  }
  for (const [key, rec] of Object.entries(from.nodes)) {
    const target = into.nodes[key];
    if (!target) {
      into.nodes[key] = cloneNodeRec(rec);
      changed = true;
    } else {
      if (wins(rec.c, target.c)) {
        target.node = cloneNode(rec.node);
        target.seq = rec.seq;
        target.c = [rec.c[0], rec.c[1]];
        changed = true;
      }
      if (rec.del && wins(rec.del.c, target.del?.c)) {
        target.del = cloneReg(rec.del);
        changed = true;
      }
    }
    if (rec.seq >= into.seq) into.seq = rec.seq + 1;
  }
  if (from.seq > into.seq) into.seq = from.seq;
  return { changed };
}

/**
 * Drop everything that can no longer influence the visible document before a
 * snapshot is persisted or sent: fields and anchors of deleted layers, plus
 * expired undo entries (kept separately, bounded). Tombstones themselves stay,
 * because a window that reconnects must not resurrect deleted objects.
 */
export function compact(state: DocState): DocState {
  const copy = cloneState(state);
  const deleted = new Set<string>();
  for (const rec of Object.values(copy.shapes)) {
    if (rec.del?.v !== true) continue;
    deleted.add(rec.id);
    rec.f = {};
  }
  for (const [key, rec] of Object.entries(copy.nodes)) {
    if (deleted.has(rec.shapeId) || rec.del?.v === true) delete copy.nodes[key];
  }
  /* `order` is a CRDT register: its value is never rewritten here, since that
     would change the value without advancing its clock. Deleted ids in it are
     inert (materialize() skips them) and are far cheaper than a log. */
  return copy;
}

/** Build the records for a freshly created shape, stamped with one clock. */
export function shapeRecords(
  shape: MaterializedShape,
  c: Clock,
  seqStart: number,
): { shape: ShapeRec; nodes: NodeRec[]; seq: number } {
  const f: ShapeRec["f"] = {};
  for (const field of FIELDS) {
    f[field] = {
      v: structuredClone(shape[field as keyof MaterializedShape]),
      c: [c[0], c[1]],
    };
  }
  let seq = seqStart;
  const nodes = shape.nodes.map((node) => ({
    shapeId: shape.id,
    node: cloneNode(node),
    seq: seq++,
    c: [c[0], c[1]] as Clock,
  }));
  return {
    shape: {
      id: shape.id,
      created: [c[0], c[1]],
      f,
      del: { v: false, c: [c[0], c[1]] },
    },
    nodes,
    seq,
  };
}
