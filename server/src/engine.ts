import { db } from './db.js';

export interface SceneMeta {
  id: number;
  title: string;
  storyTime: string;
  seq: number;
  description: string;
}

export interface SourceRef {
  sceneId: number | null; // null 表示来自对象字段的初始值
  sceneTitle: string;
  storyTime: string;
  seq: number;
}

export interface Check {
  entityId: number;
  entityName: string;
  entityKind: string;
  fieldKey: string;
  fieldLabel: string;
  expected: string;
  actual: string;
  match: boolean;
  source: SourceRef; // 推导值最近一次由谁写入（初始值或某场景的变更）
}

export interface AppliedChange {
  entityId: number;
  entityName: string;
  fieldKey: string;
  fieldLabel: string;
  before: string;
  value: string;
  note: string;
}

export interface TimelineItem {
  scene: SceneMeta;
  checks: Check[];
  changes: AppliedChange[];
  conflictCount: number;
}

export interface Conflict extends Check {
  sceneId: number;
  sceneTitle: string;
  storyTime: string;
  seq: number;
  firstDivergence: boolean; // 该「对象+字段」在故事线上的首次分歧
}

export interface ContinuityReport {
  generatedAt: string;
  timeline: TimelineItem[];
  conflicts: Conflict[];
}

interface FieldRow {
  id: number;
  entity_id: number;
  field_key: string;
  label: string;
  initial_value: string;
  sort_order: number;
  entity_name: string;
  entity_kind: string;
}

interface SceneRow {
  id: number;
  title: string;
  story_time: string;
  seq: number;
  description: string;
}

interface SnapshotRow {
  scene_id: number;
  entity_id: number;
  field_key: string;
  expected_value: string;
}

interface ChangeRow {
  id: number;
  scene_id: number;
  entity_id: number;
  field_key: string;
  value: string;
  note: string;
}

const keyOf = (entityId: number, fieldKey: string) => `${entityId}|${fieldKey}`;

/**
 * 连续性引擎：
 * 1. 以「对象字段初始值」为起点，按 (story_time, seq, id) 重放所有场景；
 * 2. 每个场景开拍前，把当前推导状态与该场景的期望快照逐字段比对；
 * 3. 比对后应用该场景登记的显式变更，并记录每个字段最近一次变更的来源场景；
 * 4. 汇总所有不一致，标记每个「对象+字段」的首次分歧及其来源场景。
 *
 * 纯函数式计算（每次请求现算），因此任何顺序/快照/变更调整都会在下次查询时自动反映。
 */
export function computeContinuity(): ContinuityReport {
  const fields = db
    .prepare(
      `SELECT f.*, e.name AS entity_name, e.kind AS entity_kind
       FROM entity_fields f JOIN entities e ON e.id = f.entity_id
       ORDER BY e.id, f.sort_order, f.id`
    )
    .all() as unknown as FieldRow[];

  const scenes = db
    .prepare('SELECT * FROM scenes ORDER BY story_time ASC, seq ASC, id ASC')
    .all() as unknown as SceneRow[];

  const snapshots = db.prepare('SELECT * FROM snapshots').all() as unknown as SnapshotRow[];
  const changes = db
    .prepare('SELECT * FROM changes ORDER BY id ASC')
    .all() as unknown as ChangeRow[];

  const fieldByKey = new Map<string, FieldRow>();
  for (const f of fields) fieldByKey.set(keyOf(f.entity_id, f.field_key), f);

  const snapsByScene = new Map<number, SnapshotRow[]>();
  for (const s of snapshots) {
    const list = snapsByScene.get(s.scene_id) ?? [];
    list.push(s);
    snapsByScene.set(s.scene_id, list);
  }
  const changesByScene = new Map<number, ChangeRow[]>();
  for (const c of changes) {
    const list = changesByScene.get(c.scene_id) ?? [];
    list.push(c);
    changesByScene.set(c.scene_id, list);
  }

  // 推导状态与来源
  const state = new Map<string, string>();
  const source = new Map<string, SourceRef>();
  for (const f of fields) {
    const k = keyOf(f.entity_id, f.field_key);
    state.set(k, f.initial_value);
    source.set(k, { sceneId: null, sceneTitle: '初始值', storyTime: '', seq: 0 });
  }

  const diverged = new Set<string>(); // 已出现首次分歧的 entity|field
  const timeline: TimelineItem[] = [];
  const conflicts: Conflict[] = [];

  for (const scene of scenes) {
    const checks: Check[] = [];

    for (const snap of snapsByScene.get(scene.id) ?? []) {
      const field = fieldByKey.get(keyOf(snap.entity_id, snap.field_key));
      if (!field) continue; // 字段已被删除的残留数据，忽略
      const k = keyOf(snap.entity_id, snap.field_key);
      const actual = state.get(k) ?? '';
      const src = source.get(k)!;
      const check: Check = {
        entityId: snap.entity_id,
        entityName: field.entity_name,
        entityKind: field.entity_kind,
        fieldKey: snap.field_key,
        fieldLabel: field.label,
        expected: snap.expected_value,
        actual,
        match: actual === snap.expected_value,
        source: src,
      };
      checks.push(check);

      if (!check.match) {
        const firstDivergence = !diverged.has(k);
        diverged.add(k);
        conflicts.push({
          ...check,
          sceneId: scene.id,
          sceneTitle: scene.title,
          storyTime: scene.story_time,
          seq: scene.seq,
          firstDivergence,
        });
      }
    }

    // 应用本场景结束后的显式变更
    const applied: AppliedChange[] = [];
    for (const ch of changesByScene.get(scene.id) ?? []) {
      const field = fieldByKey.get(keyOf(ch.entity_id, ch.field_key));
      if (!field) continue;
      const k = keyOf(ch.entity_id, ch.field_key);
      const before = state.get(k) ?? '';
      state.set(k, ch.value);
      source.set(k, {
        sceneId: scene.id,
        sceneTitle: scene.title,
        storyTime: scene.story_time,
        seq: scene.seq,
      });
      applied.push({
        entityId: ch.entity_id,
        entityName: field.entity_name,
        fieldKey: ch.field_key,
        fieldLabel: field.label,
        before,
        value: ch.value,
        note: ch.note,
      });
    }

    timeline.push({
      scene: {
        id: scene.id,
        title: scene.title,
        storyTime: scene.story_time,
        seq: scene.seq,
        description: scene.description,
      },
      checks,
      changes: applied,
      conflictCount: checks.filter((c) => !c.match).length,
    });
  }

  return { generatedAt: new Date().toISOString(), timeline, conflicts };
}
