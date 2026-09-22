import crypto from 'node:crypto';
import { db } from './db.js';
import { computeSchedule, type ScheduleReport } from './schedule.js';

/* ================================ 数据类型 ================================ */

/** 变更类型（按场景逐项比对得出） */
export type AuditChangeType =
  | 'added' // 新增：本场首次出现在排程中
  | 'removed' // 移除：本场从排程中消失（场景被删除）
  | 'date-moved' // 日期移动：拍摄日期变化
  | 'order-moved' // 顺序移动：同一拍摄日内拍摄位置变化
  | 'lock-changed' // 锁定变更：仅锁定状态变化，排程位置未变
  | 'adjusted'; // 参数调整：位置未变，但时长/故事前置/地点/分钟区间等排程参数变化

/** 变更原因（可归因多个） */
export type AuditReason =
  | 'lock' // 锁定：本场或他场的锁定/解锁操作导致
  | 'capacity' // 容量：单日预计分钟数 / 拍摄日期列表 / 本场预计分钟数导致
  | 'story-order' // 故事前置：「不可早于故事 #N」或故事序号变化导致
  | 'location' // 地点调整：拍摄地点变化导致重新分组
  | 'scene' // 场景增删：场景新增/删除引起的重排
  | 'other'; // 其他：排程规则重算

export interface AuditTrigger {
  kind: 'init' | 'settings' | 'lock' | 'unlock';
  note: string;
}

/** 单个场景在某版本中的排程落位（快照的最小单位） */
export interface AuditSceneSnap {
  sceneId: number;
  title: string;
  storyIndex: number;
  date: string; // '' = 未安排拍摄日（兜底桶）
  dayIndex: number;
  ordinal: number;
  locked: boolean;
  location: string;
  estMinutes: number;
  minStoryIndex: number;
  startMinute: number;
  endMinute: number;
  overflow: boolean;
  orderViolation: boolean;
}

export interface AuditSnapshot {
  settings: { dayMinutes: number; dates: string[] };
  scenes: AuditSceneSnap[];
}

interface ChangeDraft {
  sceneId: number;
  sceneTitle: string;
  storyIndex: number;
  changeType: AuditChangeType;
  fromDate: string;
  toDate: string;
  fromOrdinal: number;
  toOrdinal: number;
  reasons: AuditReason[];
  detail: string;
}

interface VersionRow {
  id: number;
  version_no: number;
  created_at: string;
  trigger_kind: string;
  trigger_note: string;
  base_version_id: number | null;
  base_is_baseline: number;
  fingerprint: string;
  scene_count: number;
  change_count: number;
  summary_json: string;
  snapshot_json: string;
}

interface ChangeRow {
  id: number;
  version_id: number;
  scene_id: number | null;
  scene_title: string;
  story_index: number;
  change_type: AuditChangeType;
  from_date: string;
  to_date: string;
  from_ordinal: number;
  to_ordinal: number;
  reasons_json: string;
  detail: string;
}

/* ================================ 快照与指纹 ================================ */

/** 从排程报告中提取可比较的规范快照（按场景 id 排序，保证确定性） */
export function buildSnapshot(report: ScheduleReport): AuditSnapshot {
  const scenes: AuditSceneSnap[] = [];
  for (const day of report.days) {
    for (const it of day.items) {
      scenes.push({
        sceneId: it.sceneId,
        title: it.title,
        storyIndex: it.storyIndex,
        date: day.date,
        dayIndex: day.dayIndex,
        ordinal: it.ordinal,
        locked: it.locked,
        location: it.location,
        estMinutes: it.estMinutes,
        minStoryIndex: it.minStoryIndex,
        startMinute: it.startMinute,
        endMinute: it.endMinute,
        overflow: it.overflow,
        orderViolation: it.orderViolation,
      });
    }
  }
  scenes.sort((a, b) => a.sceneId - b.sceneId);
  return {
    settings: { dayMinutes: report.settings.dayMinutes, dates: [...report.settings.dates] },
    scenes,
  };
}

/**
 * 排程结果指纹：只覆盖影响排布与展示的字段（场景标题等纯文字不参与）。
 * 相同输入重算必得相同指纹 —— 用于「同一输入重复保存不产生空版本」的幂等判定。
 */
function fingerprint(snap: AuditSnapshot): string {
  const comparable = {
    settings: { dayMinutes: snap.settings.dayMinutes, dates: snap.settings.dates },
    scenes: snap.scenes.map((s) => [
      s.sceneId,
      s.date,
      s.dayIndex,
      s.ordinal,
      s.locked ? 1 : 0,
      s.estMinutes,
      s.minStoryIndex,
      s.storyIndex,
      s.location,
      s.startMinute,
      s.endMinute,
      s.overflow ? 1 : 0,
      s.orderViolation ? 1 : 0,
    ]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(comparable)).digest('hex');
}

/* ================================ 逐项比对与原因归因 ================================ */

const dayLabel = (date: string) => (date ? date : '（未安排拍摄日）');

/**
 * 为单个场景的变更归因：只使用确定可判定的依据——
 * 触发动作本身、本场自身字段差异、排程设置差异、场景集合是否增删；
 * 均不满足时归入 'other'。返回原因集合与可展示的原因说明片段。
 */
function attribute(
  type: AuditChangeType,
  b: AuditSceneSnap | null,
  n: AuditSceneSnap | null,
  base: AuditSnapshot,
  next: AuditSnapshot,
  trigger: AuditTrigger,
  sceneSetChanged: boolean
): { reasons: AuditReason[]; parts: string[] } {
  const reasons = new Set<AuditReason>();
  const parts: string[] = [];

  // 1) 触发动作：本次保存就是锁定/解锁操作，其结果中的移动均由锁定调整引起
  if (trigger.kind === 'lock' || trigger.kind === 'unlock') {
    reasons.add('lock');
    parts.push(trigger.note);
  }

  // 2) 本场自身字段差异
  if (b && n) {
    if (b.locked !== n.locked) {
      reasons.add('lock');
      parts.push(
        n.locked ? `本场被锁定到 ${dayLabel(n.date)} 第 ${n.ordinal} 位` : '本场被解锁'
      );
    } else if (b.locked && n.locked && (b.date !== n.date || b.ordinal !== n.ordinal)) {
      reasons.add('lock');
      parts.push(
        `锁定位置由 ${dayLabel(b.date)} 第 ${b.ordinal} 位调整到 ${dayLabel(n.date)} 第 ${n.ordinal} 位`
      );
    }
    if (b.estMinutes !== n.estMinutes) {
      reasons.add('capacity');
      parts.push(`本场预计分钟数 ${b.estMinutes}→${n.estMinutes}`);
    }
    if (b.overflow !== n.overflow) {
      reasons.add('capacity');
      parts.push(n.overflow ? '本场新出现单日容量超时' : '本场容量超时消除');
    }
    if (b.minStoryIndex !== n.minStoryIndex) {
      reasons.add('story-order');
      parts.push(`不可早于故事 #${b.minStoryIndex}→#${n.minStoryIndex}`);
    }
    if (b.storyIndex !== n.storyIndex) {
      reasons.add('story-order');
      parts.push(`故事序号 #${b.storyIndex}→#${n.storyIndex}（故事时间/同刻序号调整）`);
    }
    if (b.orderViolation !== n.orderViolation) {
      reasons.add('story-order');
      parts.push(n.orderViolation ? '本场新出现故事顺序违约' : '本场故事顺序违约消除');
    }
    if (b.location !== n.location) {
      reasons.add('location');
      parts.push(`拍摄地点「${b.location || '未填写'}」→「${n.location || '未填写'}」`);
    }

    // 3) 排程设置差异（单日容量 / 拍摄日期列表）——只影响存续场次的归因
    if (base.settings.dayMinutes !== next.settings.dayMinutes) {
      reasons.add('capacity');
      parts.push(`单日预计分钟数 ${base.settings.dayMinutes}→${next.settings.dayMinutes}`);
    }
    if (base.settings.dates.join('|') !== next.settings.dates.join('|')) {
      reasons.add('capacity');
      parts.push(
        `拍摄日期列表调整（${base.settings.dates.length} 天→${next.settings.dates.length} 天）`
      );
    }

    // 4) 场景集合增删引起的重排
    if (sceneSetChanged && (type === 'date-moved' || type === 'order-moved' || type === 'adjusted')) {
      reasons.add('scene');
      parts.push('场景增删引起重排');
    }
  }

  if (type === 'added') {
    reasons.add('scene');
    parts.push('新场景进入排程');
  }
  if (type === 'removed') {
    reasons.add('scene');
    parts.push('场景已从场景管理中删除');
  }

  if (reasons.size === 0) {
    reasons.add('other');
    parts.push(trigger.kind === 'settings' ? '保存排程设置后重算' : trigger.note);
  }
  return { reasons: [...reasons], parts };
}

/** 按场景逐项比对两个快照，产出变更条目（顺序确定） */
function diffSnapshots(
  base: AuditSnapshot,
  next: AuditSnapshot,
  trigger: AuditTrigger
): ChangeDraft[] {
  const before = new Map(base.scenes.map((s) => [s.sceneId, s]));
  const after = new Map(next.scenes.map((s) => [s.sceneId, s]));
  const sceneSetChanged =
    base.scenes.length !== next.scenes.length ||
    next.scenes.some((s) => !before.has(s.sceneId));

  const drafts: ChangeDraft[] = [];
  const push = (
    type: AuditChangeType,
    b: AuditSceneSnap | null,
    n: AuditSceneSnap | null,
    moveDesc: string
  ) => {
    const { reasons, parts } = attribute(type, b, n, base, next, trigger, sceneSetChanged);
    const ref = (n ?? b)!;
    drafts.push({
      sceneId: ref.sceneId,
      sceneTitle: ref.title,
      storyIndex: ref.storyIndex,
      changeType: type,
      fromDate: b?.date ?? '',
      toDate: n?.date ?? '',
      fromOrdinal: b?.ordinal ?? 0,
      toOrdinal: n?.ordinal ?? 0,
      reasons,
      detail: `${moveDesc}原因：${parts.join('；')}。`,
    });
  };

  // 新增（按场景 id 顺序，确定性）
  for (const n of next.scenes) {
    if (before.has(n.sceneId)) continue;
    push('added', null, n, `新增：排入 ${dayLabel(n.date)} 第 ${n.ordinal} 位。`);
  }
  // 移除
  for (const b of base.scenes) {
    if (after.has(b.sceneId)) continue;
    push('removed', b, null, `移除：原排于 ${dayLabel(b.date)} 第 ${b.ordinal} 位。`);
  }
  // 存续场景：位置 / 锁定 / 参数
  for (const n of next.scenes) {
    const b = before.get(n.sceneId);
    if (!b) continue;
    const dateMoved = b.date !== n.date || b.dayIndex !== n.dayIndex;
    const orderMoved = !dateMoved && b.ordinal !== n.ordinal;
    const lockChanged = !dateMoved && !orderMoved && b.locked !== n.locked;
    const adjusted =
      !dateMoved &&
      !orderMoved &&
      !lockChanged &&
      (b.estMinutes !== n.estMinutes ||
        b.minStoryIndex !== n.minStoryIndex ||
        b.location !== n.location ||
        b.storyIndex !== n.storyIndex ||
        b.startMinute !== n.startMinute ||
        b.endMinute !== n.endMinute ||
        b.overflow !== n.overflow ||
        b.orderViolation !== n.orderViolation);

    if (dateMoved) {
      push(
        'date-moved',
        b,
        n,
        `日期移动：${dayLabel(b.date)} 第 ${b.ordinal} 位 → ${dayLabel(n.date)} 第 ${n.ordinal} 位。`
      );
    } else if (orderMoved) {
      push(
        'order-moved',
        b,
        n,
        `顺序移动：${dayLabel(n.date)} 内第 ${b.ordinal} 位 → 第 ${n.ordinal} 位。`
      );
    } else if (lockChanged) {
      push(
        'lock-changed',
        b,
        n,
        n.locked
          ? `锁定变更：锁定于 ${dayLabel(n.date)} 第 ${n.ordinal} 位（排程位置未变）。`
          : '锁定变更：解除锁定（排程位置未变）。'
      );
    } else if (adjusted) {
      push(
        'adjusted',
        b,
        n,
        `参数调整：位置不变（${dayLabel(n.date)} 第 ${n.ordinal} 位），分钟区间 ${b.startMinute}–${b.endMinute} → ${n.startMinute}–${n.endMinute}。`
      );
    }
  }
  return drafts;
}

function summarize(changes: ChangeDraft[]) {
  const byType: Record<AuditChangeType, number> = {
    added: 0,
    removed: 0,
    'date-moved': 0,
    'order-moved': 0,
    'lock-changed': 0,
    adjusted: 0,
  };
  const byReason: Record<AuditReason, number> = {
    lock: 0,
    capacity: 0,
    'story-order': 0,
    location: 0,
    scene: 0,
    other: 0,
  };
  for (const c of changes) {
    byType[c.changeType] += 1;
    for (const r of c.reasons) byReason[r] += 1;
  }
  return { byType, byReason };
}

/* ================================ 版本记录 ================================ */

/**
 * 在一次「保存并重算」后记录审计版本：
 * - 首个版本只落快照、不产生变更条目，作为后续比较起点；
 * - 对比基准 = 当前基线（若已设置且存在），否则上一版；
 * - 与上一版或对比基准的结果指纹一致、或逐项比对后无任何场次变化时，
 *   不写入新版本（同一输入重复保存 / 无实际影响的保存都不产生空版本）。
 *
 * 可在事务内调用（嵌套时退化为保存点）；返回是否真正产生了新版本。
 */
export function recordScheduleVersion(
  trigger: AuditTrigger,
  report?: ScheduleReport
): { created: boolean; versionNo: number | null } {
  const rep = report ?? computeSchedule();
  const snap = buildSnapshot(rep);
  const fp = fingerprint(snap);

  const latest = db
    .prepare('SELECT * FROM schedule_audit_versions ORDER BY version_no DESC LIMIT 1')
    .get() as VersionRow | undefined;

  if (!latest) {
    db.prepare(
      `INSERT INTO schedule_audit_versions
         (version_no, trigger_kind, trigger_note, base_version_id, base_is_baseline,
          fingerprint, scene_count, change_count, summary_json, snapshot_json)
       VALUES (1, ?, ?, NULL, 0, ?, ?, 0, ?, ?)`
    ).run(
      trigger.kind,
      trigger.note,
      fp,
      snap.scenes.length,
      JSON.stringify(summarize([])),
      JSON.stringify(snap)
    );
    return { created: true, versionNo: 1 };
  }

  const meta = db
    .prepare('SELECT baseline_version_id FROM schedule_audit_meta WHERE id = 1')
    .get() as { baseline_version_id: number | null } | undefined;
  let baseRow = latest;
  let baseIsBaseline = 0;
  if (meta?.baseline_version_id) {
    const baseline = db
      .prepare('SELECT * FROM schedule_audit_versions WHERE id = ?')
      .get(meta.baseline_version_id) as VersionRow | undefined;
    if (baseline) {
      baseRow = baseline;
      baseIsBaseline = 1;
    }
  }

  // 幂等：与上一版相同（重复保存），或回到了对比基准的状态（如撤销回基线）→ 不产生空版本
  if (fp === latest.fingerprint || fp === baseRow.fingerprint) {
    return { created: false, versionNo: null };
  }

  const baseSnap = JSON.parse(baseRow.snapshot_json) as AuditSnapshot;
  const changes = diffSnapshots(baseSnap, snap, trigger);
  if (changes.length === 0) {
    // 仅设置变化但未影响任何场次排布 → 同样不产生空版本
    return { created: false, versionNo: null };
  }

  const versionNo = latest.version_no + 1;
  const insertAll = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO schedule_audit_versions
           (version_no, trigger_kind, trigger_note, base_version_id, base_is_baseline,
            fingerprint, scene_count, change_count, summary_json, snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        versionNo,
        trigger.kind,
        trigger.note,
        baseRow.id,
        baseIsBaseline,
        fp,
        snap.scenes.length,
        changes.length,
        JSON.stringify(summarize(changes)),
        JSON.stringify(snap)
      );
    const versionId = info.lastInsertRowid as number;
    const insChange = db.prepare(
      `INSERT INTO schedule_audit_changes
         (version_id, scene_id, scene_title, story_index, change_type,
          from_date, to_date, from_ordinal, to_ordinal, reasons_json, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of changes) {
      insChange.run(
        versionId,
        c.sceneId,
        c.sceneTitle,
        c.storyIndex,
        c.changeType,
        c.fromDate,
        c.toDate,
        c.fromOrdinal,
        c.toOrdinal,
        JSON.stringify(c.reasons),
        c.detail
      );
    }
  });
  insertAll();
  return { created: true, versionNo };
}

/* ================================ 查询 ================================ */

function currentBaselineId(): number | null {
  const meta = db
    .prepare('SELECT baseline_version_id FROM schedule_audit_meta WHERE id = 1')
    .get() as { baseline_version_id: number | null } | undefined;
  return meta?.baseline_version_id ?? null;
}

function versionDto(r: VersionRow & { base_version_no: number | null }, baselineId: number | null) {
  return {
    id: r.id,
    versionNo: r.version_no,
    createdAt: r.created_at,
    triggerKind: r.trigger_kind,
    triggerNote: r.trigger_note,
    baseVersionId: r.base_version_id,
    baseVersionNo: r.base_version_no,
    baseIsBaseline: r.base_is_baseline === 1,
    sceneCount: r.scene_count,
    changeCount: r.change_count,
    summary: JSON.parse(r.summary_json) as ReturnType<typeof summarize>,
    isBaseline: r.id === baselineId,
  };
}

const VERSION_SELECT = `
  SELECT v.*, b.version_no AS base_version_no
  FROM schedule_audit_versions v
  LEFT JOIN schedule_audit_versions b ON b.id = v.base_version_id`;

/** 版本列表（新→旧）+ 当前基线 */
export function listAuditVersions() {
  const baselineId = currentBaselineId();
  const rows = db
    .prepare(`${VERSION_SELECT} ORDER BY v.version_no DESC`)
    .all() as (VersionRow & { base_version_no: number | null })[];
  return {
    baselineVersionId: baselineId,
    versions: rows.map((r) => versionDto(r, baselineId)),
  };
}

/** 版本详情：元信息 + 逐场景变更 + 本版排程快照 */
export function getAuditVersion(id: number) {
  const r = db.prepare(`${VERSION_SELECT} WHERE v.id = ?`).get(id) as
    | (VersionRow & { base_version_no: number | null })
    | undefined;
  if (!r) return null;
  const baselineId = currentBaselineId();
  const changes = (
    db.prepare('SELECT * FROM schedule_audit_changes WHERE version_id = ?').all(id) as ChangeRow[]
  )
    .map((c) => ({
      id: c.id,
      sceneId: c.scene_id,
      sceneTitle: c.scene_title,
      storyIndex: c.story_index,
      changeType: c.change_type,
      fromDate: c.from_date,
      toDate: c.to_date,
      fromOrdinal: c.from_ordinal,
      toOrdinal: c.to_ordinal,
      reasons: JSON.parse(c.reasons_json) as AuditReason[],
      detail: c.detail,
    }))
    // 展示顺序确定：按落位（新位置优先，移除场景用原位置），再按场景 id
    .sort((a, b) => {
      const ad = a.toDate || a.fromDate;
      const bd = b.toDate || b.fromDate;
      const ao = a.toOrdinal || a.fromOrdinal;
      const bo = b.toOrdinal || b.fromOrdinal;
      return ad < bd ? -1 : ad > bd ? 1 : ao - bo || (a.sceneId ?? 0) - (b.sceneId ?? 0);
    });

  return {
    ...versionDto(r, baselineId),
    changes,
    snapshot: JSON.parse(r.snapshot_json) as AuditSnapshot,
  };
}

/** 设置/清除基线（versionId = null 表示清除，恢复与上一版比较） */
export function setAuditBaseline(versionId: number | null): void {
  db.prepare(
    `INSERT INTO schedule_audit_meta (id, baseline_version_id) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET baseline_version_id = excluded.baseline_version_id`
  ).run(versionId);
}
