import crypto from 'node:crypto';
import { db } from './db.js';
import { computeSchedule, computeStoryOrder, type ScheduleReport } from './schedule.js';

/* ================================ 数据类型 ================================ */

/** 审计版本的产生方式 */
export type AuditTrigger = 'init' | 'settings' | 'lock' | 'unlock' | 'manual' | 'compare';

/** 场次变更类型 */
export type AuditChangeType =
  | 'added' // 新版出现（新场景进入排程）
  | 'removed' // 新版不再出现（场景离开排程）
  | 'date-moved' // 拍摄日期变化
  | 'order-moved' // 同日内拍摄顺序（位置）变化
  | 'lock-changed'; // 日期/位置相同但锁定状态变化

/** 变更原因类别 */
export type AuditReasonCode =
  | 'lock' // 场次锁定 / 解锁
  | 'capacity' // 拍摄日期或单日容量调整、容量溢出
  | 'story-prereq' // 不可提前的故事序号（故事前置）约束
  | 'new-scene' // 新增的场景
  | 'removed-scene' // 移除的场景
  | 'other';

export interface AuditReason {
  code: AuditReasonCode;
  message: string;
}

/** 一版排程中单个场景的位置快照 */
export interface AuditSnapshotItem {
  sceneId: number;
  sceneTitle: string;
  storyIndex: number;
  dayIndex: number; // -1 = 未排入任何拍摄日（含未配置拍摄日）
  date: string;
  ordinal: number;
  locked: boolean;
  estMinutes: number;
  minStoryIndex: number;
  overflow: boolean;
  orderViolation: boolean;
}

export interface AuditSnapshot {
  dayMinutes: number;
  dates: string[];
  items: AuditSnapshotItem[]; // 覆盖全部场景（含未排入拍摄日者）
}

export interface AuditChange {
  id?: number;
  sceneId: number;
  sceneTitle: string;
  storyIndex: number;
  changeType: AuditChangeType;
  reasons: AuditReason[];
  fromDate: string;
  toDate: string;
  fromOrdinal: number | null;
  toOrdinal: number | null;
  fromLocked: boolean;
  toLocked: boolean;
}

export interface AuditSummary {
  added: number;
  removed: number;
  dateMoved: number;
  orderMoved: number;
  lockChanged: number;
}

export interface AuditDateStat {
  dayIndex: number;
  date: string;
  /** 该日期在基准版承载的场次数 */
  beforeCount: number;
  /** 该日期在新版本承载的场次数 */
  afterCount: number;
}

/** 版本详情 / 任意两版比较的统一 DTO（compareMode 时不含版本元数据以外的触发信息） */
export interface AuditDetailDto {
  baseVersion: AuditVersionMeta | null;
  targetVersion: AuditVersionMeta | null;
  compareMode: boolean;
  summary: AuditSummary;
  dateStats: AuditDateStat[];
  totalScenesBefore: number;
  totalScenesAfter: number;
  changes: AuditChange[];
  /** 未发生变更的场次（勾选「显示全部场次」时前端使用） */
  unchanged: {
    sceneId: number;
    sceneTitle: string;
    storyIndex: number;
    date: string;
    ordinal: number;
    locked: boolean;
  }[];
}

export interface AuditVersionMeta {
  id: number;
  trigger: AuditTrigger;
  note: string;
  baseVersionId: number | null;
  isBaseline: boolean;
  dayMinutes: number;
  createdAt: string;
}

export interface AuditVersionSummary extends AuditVersionMeta {
  dates: string[];
  summary: AuditSummary;
  changeCount: number;
  totalScenes: number;
}

export interface AuditListResult {
  baselineId: number | null;
  latestId: number | null;
  /** 当前工作区排程相对最新审计版本是否已漂移（有未归档的改动） */
  drift: boolean;
  versions: AuditVersionSummary[];
}

/** 写接口返回：最新排程 + 设置 + 本次审计结果（重复保存时 audit 为 null） */
export interface ScheduleSaveResult {
  schedule: ScheduleReport;
  settings: { dayMinutes: number; dates: string[] };
  audit: AuditVersionSummary | null;
  /** 未生成新版本的原因（audit 为 null 时有值） */
  auditSkippedReason: string | null;
}

/* ================================ 快照与指纹 ================================ */

interface SceneSchedRow {
  id: number;
  title: string;
  story_time: string;
  seq: number;
  est_minutes: number;
  min_story_index: number;
}

/** 从一次排程结果中提取逐场景位置快照；对未能排入任何拍摄日的场景补齐 dayIndex=-1 的记录 */
export function snapshotFromReport(report: ScheduleReport): AuditSnapshot {
  const items: AuditSnapshotItem[] = [];
  const placed = new Set<number>();

  for (const day of report.days) {
    for (const it of day.items) {
      items.push({
        sceneId: it.sceneId,
        sceneTitle: it.title,
        storyIndex: it.storyIndex,
        dayIndex: day.dayIndex,
        date: day.date,
        ordinal: it.ordinal,
        locked: it.locked,
        estMinutes: it.estMinutes,
        minStoryIndex: it.minStoryIndex,
        overflow: it.overflow,
        orderViolation: it.orderViolation,
      });
      placed.add(it.sceneId);
    }
  }

  // 未出现在排程结果中的场景（理论上仅极端兜底情况）：补齐快照，避免被误判为移除
  const rows = db
    .prepare(
      `SELECT id, title, story_time, seq, est_minutes, min_story_index
       FROM scenes ORDER BY story_time ASC, seq ASC, id ASC`
    )
    .all() as SceneSchedRow[];
  const storyIndex = computeStoryOrder(rows);
  for (const r of rows) {
    if (placed.has(r.id)) continue;
    items.push({
      sceneId: r.id,
      sceneTitle: r.title,
      storyIndex: storyIndex.get(r.id)!,
      dayIndex: -1,
      date: '',
      ordinal: 0,
      locked: false,
      estMinutes: r.est_minutes,
      minStoryIndex: r.min_story_index,
      overflow: false,
      orderViolation: false,
    });
  }

  items.sort((a, b) => a.storyIndex - b.storyIndex || a.sceneId - b.sceneId);
  return { dayMinutes: report.settings.dayMinutes, dates: report.settings.dates, items };
}

/** 排程输入指纹：拍摄日期、单日容量、锁定、以及各场景的排程字段（地点/时长/故事前置） */
export function currentInputHash(): string {
  const settings = db
    .prepare('SELECT day_minutes FROM schedule_settings WHERE id = 1')
    .get() as { day_minutes: number } | undefined;
  const dates = (
    db.prepare('SELECT date FROM schedule_dates ORDER BY sort_order ASC').all() as { date: string }[]
  ).map((d) => d.date);
  const locks = (
    db
      .prepare('SELECT scene_id, date, ordinal FROM schedule_locks ORDER BY scene_id')
      .all() as { scene_id: number; date: string; ordinal: number }[]
  ).map((l) => `${l.scene_id}@${l.date}#${l.ordinal}`);
  const scenes = (
    db
      .prepare(
        `SELECT id, story_time, seq, location, est_minutes, min_story_index
         FROM scenes ORDER BY id`
      )
      .all() as {
      id: number;
      story_time: string;
      seq: number;
      location: string;
      est_minutes: number;
      min_story_index: number;
    }[]
  ).map(
    (s) =>
      `${s.id}:${s.story_time}|${s.seq}|${s.location.trim()}|${s.est_minutes}|${s.min_story_index}`
  );
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        dayMinutes: settings?.day_minutes ?? 480,
        dates,
        locks,
        scenes,
      })
    )
    .digest('hex');
}

/* ================================ 比对引擎 ================================ */

const CHANGE_ORDER: AuditChangeType[] = [
  'added',
  'removed',
  'date-moved',
  'order-moved',
  'lock-changed',
];

function emptySummary(): AuditSummary {
  return { added: 0, removed: 0, dateMoved: 0, orderMoved: 0, lockChanged: 0 };
}

function bump(summary: AuditSummary, type: AuditChangeType, by = 1): void {
  if (type === 'added') summary.added += by;
  else if (type === 'removed') summary.removed += by;
  else if (type === 'date-moved') summary.dateMoved += by;
  else if (type === 'order-moved') summary.orderMoved += by;
  else summary.lockChanged += by;
}

/**
 * 逐项比对两版排程快照。
 * 同一日期按「拍摄日序号」对齐（即使日期被改名）；dayIndex=-1 表示未排入任何拍摄日。
 */
export function diffSnapshots(before: AuditSnapshot, after: AuditSnapshot): {
  changes: AuditChange[];
  summary: AuditSummary;
  dateStats: AuditDateStat[];
  unchanged: AuditDetailDto['unchanged'];
} {
  const beforeMap = new Map(before.items.map((it) => [it.sceneId, it]));
  const afterMap = new Map(after.items.map((it) => [it.sceneId, it]));
  const changes: AuditChange[] = [];
  const summary = emptySummary();
  const unchanged: AuditDetailDto['unchanged'] = [];

  const push = (c: AuditChange) => {
    changes.push(c);
    bump(summary, c.changeType);
  };

  for (const a of after.items) {
    const b = beforeMap.get(a.sceneId);
    if (!b) {
      push({
        sceneId: a.sceneId,
        sceneTitle: a.sceneTitle,
        storyIndex: a.storyIndex,
        changeType: 'added',
        reasons: [
          {
            code: 'new-scene',
            message: a.date
              ? `新增场景：本版首次排入拍摄计划（${a.date} 第 ${a.ordinal} 位）。`
              : '新增场景：本版首次出现，但尚未能排入任何拍摄日。',
          },
        ],
        fromDate: '',
        toDate: a.date,
        fromOrdinal: null,
        toOrdinal: a.ordinal || null,
        fromLocked: false,
        toLocked: a.locked,
      });
      continue;
    }

    const sameDate = b.dayIndex === a.dayIndex && b.date === a.date;
    if (!sameDate) {
      push({
        sceneId: a.sceneId,
        sceneTitle: a.sceneTitle,
        storyIndex: a.storyIndex,
        changeType: 'date-moved',
        reasons: buildMoveReasons(b, a, before, after),
        fromDate: b.date,
        toDate: a.date,
        fromOrdinal: b.ordinal || null,
        toOrdinal: a.ordinal || null,
        fromLocked: b.locked,
        toLocked: a.locked,
      });
      continue;
    }

    if (b.ordinal !== a.ordinal) {
      push({
        sceneId: a.sceneId,
        sceneTitle: a.sceneTitle,
        storyIndex: a.storyIndex,
        changeType: 'order-moved',
        reasons: buildMoveReasons(b, a, before, after),
        fromDate: b.date,
        toDate: a.date,
        fromOrdinal: b.ordinal || null,
        toOrdinal: a.ordinal || null,
        fromLocked: b.locked,
        toLocked: a.locked,
      });
      continue;
    }

    if (b.locked !== a.locked) {
      push({
        sceneId: a.sceneId,
        sceneTitle: a.sceneTitle,
        storyIndex: a.storyIndex,
        changeType: 'lock-changed',
        reasons: [
          a.locked
            ? {
                code: 'lock',
                message: `锁定：本场被锁定为 ${a.date} 第 ${a.ordinal} 个拍摄位置，重算时作为锚点固定。`,
              }
            : {
                code: 'lock',
                message: '解锁：取消锁定后，本场回到由排程规则自动安排的候选池。',
              },
        ],
        fromDate: b.date,
        toDate: a.date,
        fromOrdinal: b.ordinal || null,
        toOrdinal: a.ordinal || null,
        fromLocked: b.locked,
        toLocked: a.locked,
      });
      continue;
    }

    unchanged.push({
      sceneId: a.sceneId,
      sceneTitle: a.sceneTitle,
      storyIndex: a.storyIndex,
      date: a.date,
      ordinal: a.ordinal,
      locked: a.locked,
    });
  }

  for (const b of before.items) {
    if (afterMap.has(b.sceneId)) continue;
    push({
      sceneId: b.sceneId,
      sceneTitle: b.sceneTitle,
      storyIndex: b.storyIndex,
      changeType: 'removed',
      reasons: [
        {
          code: 'removed-scene',
          message: b.date
            ? `移除场景：上一版位于 ${b.date} 第 ${b.ordinal} 位，本版不再出现在拍摄计划中。`
            : '移除场景：上一版未排入拍摄日，本版场景已不存在。',
        },
      ],
      fromDate: b.date,
      toDate: '',
      fromOrdinal: b.ordinal || null,
      toOrdinal: null,
      fromLocked: b.locked,
      toLocked: false,
    });
  }

  changes.sort(
    (x, y) =>
      CHANGE_ORDER.indexOf(x.changeType) - CHANGE_ORDER.indexOf(y.changeType) ||
      x.storyIndex - y.storyIndex ||
      x.sceneId - y.sceneId
  );

  return { changes, summary, dateStats: buildDateStats(before, after), unchanged };
}

/** 统计每个拍摄日（按日期对齐）在两版中的场次数 */
function buildDateStats(before: AuditSnapshot, after: AuditSnapshot): AuditDateStat[] {
  const map = new Map<string, AuditDateStat>();
  const ensure = (date: string, dayIndex: number) => {
    const key = date || `__none_${dayIndex}`;
    let s = map.get(key);
    if (!s) {
      s = { dayIndex, date, beforeCount: 0, afterCount: 0 };
      map.set(key, s);
    }
    return s;
  };
  for (const it of before.items) {
    if (it.dayIndex < 0) continue;
    ensure(it.date, it.dayIndex).beforeCount += 1;
  }
  for (const it of after.items) {
    if (it.dayIndex < 0) continue;
    ensure(it.date, it.dayIndex).afterCount += 1;
  }
  return [...map.values()].sort((a, b) => {
    // 同名日期优先并排展示；其次按拍摄日序号
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.dayIndex - b.dayIndex;
  });
}

/* ------------------------- 移动原因：锁定 / 容量 / 故事前置 ------------------------- */

function buildMoveReasons(
  b: AuditSnapshotItem,
  a: AuditSnapshotItem,
  before: AuditSnapshot,
  after: AuditSnapshot
): AuditReason[] {
  const reasons: AuditReason[] = [];
  const loc = (s: AuditSnapshotItem) =>
    s.date ? `${s.date} 第 ${s.ordinal} 位` : '未排入任何拍摄日';

  // 1) 锁定
  if (a.locked && !b.locked) {
    reasons.push({
      code: 'lock',
      message: `锁定导致移动：本场被锁定为 ${a.date} 第 ${a.ordinal} 个拍摄位置。`,
    });
  } else if (b.locked && !a.locked) {
    reasons.push({
      code: 'lock',
      message: `解锁导致移动：原锁定（${b.date} 第 ${b.ordinal} 位）解除后，由排程规则重新安排到${loc(a)}。`,
    });
  } else if (a.locked && b.locked && (a.date !== b.date || a.ordinal !== b.ordinal)) {
    reasons.push({
      code: 'lock',
      message: `锁定位置调整：锁定由 ${b.date} 第 ${b.ordinal} 位改为 ${a.date} 第 ${a.ordinal} 位。`,
    });
  } else {
    // 本场虽未锁定，也可能被其他场次的锁定锚点挤动
    const lockCountDelta = after.items.filter((i) => i.locked).length - before.items.filter((i) => i.locked).length;
    if (lockCountDelta > 0) {
      reasons.push({
        code: 'lock',
        message: '锁定锚点重排：其他场次的锁定改变了可填充空位，本场随确定性排程规则移动。',
      });
    }
  }

  // 2) 容量：单日分钟数变化 / 拍摄日期集合变化 / 容量溢出
  const capacityBits: string[] = [];
  if (before.dayMinutes !== after.dayMinutes) {
    capacityBits.push(`单日预计容量由 ${before.dayMinutes} 分钟调整为 ${after.dayMinutes} 分钟`);
  }
  const beforeDateSet = new Set(before.dates);
  const afterDateSet = new Set(after.dates);
  const addedDates = after.dates.filter((d) => !beforeDateSet.has(d));
  const removedDates = before.dates.filter((d) => !afterDateSet.has(d));
  if (addedDates.length > 0) capacityBits.push(`新增拍摄日 ${addedDates.join('、')}`);
  if (removedDates.length > 0) capacityBits.push(`移除拍摄日 ${removedDates.join('、')}`);
  if (capacityBits.length > 0) {
    reasons.push({
      code: 'capacity',
      message: `容量/排期调整：${capacityBits.join('；')}，各拍摄日重新装载，本场移至${loc(a)}。`,
    });
  } else if (a.overflow || b.overflow) {
    reasons.push({
      code: 'capacity',
      message: a.overflow
        ? `容量冲突：排入后超出当日预计 ${after.dayMinutes} 分钟，本场被顺延至${loc(a)}。`
        : `容量重排：上一版本场所在拍摄日超载（${before.dayMinutes} 分钟上限），重算后移至${loc(a)}。`,
    });
  }

  // 3) 故事前置：不可提前的故事序号约束，或移动后出现/消除顺序违约
  if (a.minStoryIndex > 0 && (b.orderViolation !== a.orderViolation || reasons.length === 0)) {
    reasons.push({
      code: 'story-prereq',
      message: a.orderViolation
        ? `故事前置约束：本场要求故事 #1～#${a.minStoryIndex} 先拍，移至${loc(a)}时前置故事尚未拍完（顺序冲突）。`
        : `故事前置约束：须等故事 #1～#${a.minStoryIndex} 全部拍完后方可拍摄，受可用拍摄日限制移至${loc(a)}。`,
    });
  } else if (b.orderViolation !== a.orderViolation) {
    reasons.push({
      code: 'story-prereq',
      message: a.orderViolation
        ? '故事前置：移动后本场早于其前置故事拍摄，产生顺序冲突。'
        : '故事前置：移动后前置故事已先拍完，顺序冲突消除。',
    });
  }

  if (reasons.length === 0) {
    reasons.push({
      code: 'other',
      message: `排程重算：在故事顺序与锁定约束下按「同地点合并优先、最小化地点切换」规则重新装载，本场由${loc(b)}移至${loc(a)}。`,
    });
  }
  return reasons;
}

/* ================================ 持久化 ================================ */

interface VersionRow {
  id: number;
  trigger: AuditTrigger;
  note: string;
  base_version_id: number | null;
  is_baseline: number;
  day_minutes: number;
  input_hash: string;
  created_at: string;
}

function insertVersion(
  trigger: AuditTrigger,
  note: string,
  baseVersionId: number | null,
  isBaseline: boolean,
  snapshot: AuditSnapshot,
  inputHash: string,
  changes: AuditChange[]
): number {
  return db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO schedule_audit_versions
           (trigger, note, base_version_id, is_baseline, day_minutes, input_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(trigger, note, baseVersionId, isBaseline ? 1 : 0, snapshot.dayMinutes, inputHash)
      .lastInsertRowid as number;

    const insDate = db.prepare(
      'INSERT INTO schedule_audit_dates (version_id, date, sort_order) VALUES (?, ?, ?)'
    );
    snapshot.dates.forEach((d, i) => insDate.run(id, d, i + 1));

    const insItem = db.prepare(
      `INSERT INTO schedule_audit_items
         (version_id, scene_id, scene_title, story_index, day_index, date, ordinal,
          locked, est_minutes, min_story_index, overflow, order_violation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const it of snapshot.items) {
      insItem.run(
        id,
        it.sceneId,
        it.sceneTitle,
        it.storyIndex,
        it.dayIndex,
        it.date,
        it.ordinal,
        it.locked ? 1 : 0,
        it.estMinutes,
        it.minStoryIndex,
        it.overflow ? 1 : 0,
        it.orderViolation ? 1 : 0
      );
    }

    const insChange = db.prepare(
      `INSERT INTO schedule_audit_changes
         (version_id, scene_id, scene_title, story_index, change_type, reasons,
          from_date, to_date, from_ordinal, to_ordinal, from_locked, to_locked, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    changes.forEach((c, i) => {
      insChange.run(
        id,
        c.sceneId,
        c.sceneTitle,
        c.storyIndex,
        c.changeType,
        JSON.stringify(c.reasons),
        c.fromDate,
        c.toDate,
        c.fromOrdinal,
        c.toOrdinal,
        c.fromLocked ? 1 : 0,
        c.toLocked ? 1 : 0,
        i + 1
      );
    });
    return id;
  })();
}

function loadSnapshot(versionId: number): AuditSnapshot | null {
  const ver = db
    .prepare('SELECT day_minutes FROM schedule_audit_versions WHERE id = ?')
    .get(versionId) as { day_minutes: number } | undefined;
  if (!ver) return null;
  const dates = (
    db
      .prepare('SELECT date FROM schedule_audit_dates WHERE version_id = ? ORDER BY sort_order')
      .all(versionId) as { date: string }[]
  ).map((d) => d.date);
  const rows = db
    .prepare('SELECT * FROM schedule_audit_items WHERE version_id = ? ORDER BY story_index, scene_id')
    .all(versionId) as {
    scene_id: number;
    scene_title: string;
    story_index: number;
    day_index: number;
    date: string;
    ordinal: number;
    locked: number;
    est_minutes: number;
    min_story_index: number;
    overflow: number;
    order_violation: number;
  }[];
  return {
    dayMinutes: ver.day_minutes,
    dates,
    items: rows.map((r) => ({
      sceneId: r.scene_id,
      sceneTitle: r.scene_title,
      storyIndex: r.story_index,
      dayIndex: r.day_index,
      date: r.date,
      ordinal: r.ordinal,
      locked: r.locked === 1,
      estMinutes: r.est_minutes,
      minStoryIndex: r.min_story_index,
      overflow: r.overflow === 1,
      orderViolation: r.order_violation === 1,
    })),
  };
}

/* ------------------------- 触发记录（设置 / 锁定 / 手工） ------------------------- */

/** 首次启动：以当前排程建立第 1 版（审计起点快照），库中已有版本时跳过 */
export function ensureInitialVersion(): AuditVersionSummary | null {
  const n = db.prepare('SELECT COUNT(*) AS n FROM schedule_audit_versions').get() as { n: number };
  if (n.n > 0) return null;
  const report = computeSchedule();
  const snapshot = snapshotFromReport(report);
  const id = insertVersion(
    'init',
    '初始版本：排程审计的起点快照（之后每次保存默认与上一版逐项比对；可手动将任一版本标记为基线）。',
    null,
    false,
    snapshot,
    currentInputHash(),
    []
  );
  return getVersionSummary(id)!;
}

interface RecordOptions {
  trigger: AuditTrigger;
  note: string;
}

export interface RecordOutcome {
  result: ScheduleSaveResult;
  versionId: number | null;
}

/**
 * 保存拍摄日期 / 容量 / 锁定并重算后调用：与基线（未标记时为上一版）逐项比对并落库。
 * 同一输入重复保存（指纹相同）或比对结果为空（零变更）时不产生空版本。
 */
export function recordScheduleAudit(opts: RecordOptions): RecordOutcome {
  const report = computeSchedule();
  const settings = { dayMinutes: report.settings.dayMinutes, dates: report.settings.dates };
  const snapshot = snapshotFromReport(report);
  const inputHash = currentInputHash();

  const skipped = (reason: string): RecordOutcome => ({
    result: { schedule: report, settings, audit: null, auditSkippedReason: reason },
    versionId: null,
  });

  // 去重 1：与最新版本输入完全相同（同一输入重复保存）
  const latest = db
    .prepare('SELECT id, input_hash FROM schedule_audit_versions ORDER BY id DESC LIMIT 1')
    .get() as { id: number; input_hash: string } | undefined;
  if (latest && latest.input_hash === inputHash) {
    return skipped('输入与上一版完全相同，重复保存未产生空版本。');
  }

  // 比对基准：已标记的基线优先；否则取最新版本
  const base =
    (db
      .prepare('SELECT id FROM schedule_audit_versions WHERE is_baseline = 1 ORDER BY id DESC LIMIT 1')
      .get() as { id: number } | undefined) ?? latest;
  const baseSnapshot = base ? loadSnapshot(base.id) : null;

  const diff = baseSnapshot
    ? diffSnapshots(baseSnapshot, snapshot)
    : {
        changes: snapshot.items.map((a) => ({
          sceneId: a.sceneId,
          sceneTitle: a.sceneTitle,
          storyIndex: a.storyIndex,
          changeType: 'added' as const,
          reasons: [
            {
              code: 'new-scene' as const,
              message: a.date
                ? `新增场景：首个审计版本，纳入 ${a.date} 第 ${a.ordinal} 位。`
                : '新增场景：首个审计版本，尚未能排入任何拍摄日。',
            },
          ],
          fromDate: '',
          toDate: a.date,
          fromOrdinal: null,
          toOrdinal: a.ordinal || null,
          fromLocked: false,
          toLocked: a.locked,
        })),
        summary: { ...emptySummary(), added: snapshot.items.length },
        dateStats: buildDateStats({ ...snapshot, items: [] }, snapshot),
        unchanged: [],
      };

  // 去重 2：与基准逐项比对无差异 => 不产生空版本
  if (diff.changes.length === 0) {
    return skipped('重算结果与基准版本逐项一致，未产生新版本。');
  }

  const versionId = insertVersion(
    opts.trigger,
    opts.note,
    base ? base.id : null,
    false,
    snapshot,
    inputHash,
    diff.changes
  );
  const audit = getVersionSummary(versionId)!;
  return {
    result: { schedule: report, settings, audit, auditSkippedReason: null },
    versionId,
  };
}

/* ================================ 查询 API ================================ */

function rowToMeta(r: VersionRow): AuditVersionMeta {
  return {
    id: r.id,
    trigger: r.trigger,
    note: r.note,
    baseVersionId: r.base_version_id,
    isBaseline: r.is_baseline === 1,
    dayMinutes: r.day_minutes,
    createdAt: r.created_at,
  };
}

function summaryOfVersion(r: VersionRow): AuditVersionSummary {
  const dates = (
    db
      .prepare('SELECT date FROM schedule_audit_dates WHERE version_id = ? ORDER BY sort_order')
      .all(r.id) as { date: string }[]
  ).map((d) => d.date);
  const countRow = db
    .prepare('SELECT COUNT(*) AS n FROM schedule_audit_changes WHERE version_id = ?')
    .get(r.id) as { n: number };
  const typeRows = db
    .prepare('SELECT change_type, COUNT(*) AS n FROM schedule_audit_changes WHERE version_id = ? GROUP BY change_type')
    .all(r.id) as { change_type: AuditChangeType; n: number }[];
  const sceneRow = db
    .prepare('SELECT COUNT(*) AS n FROM schedule_audit_items WHERE version_id = ? AND day_index >= 0')
    .get(r.id) as { n: number };
  const summary = emptySummary();
  for (const t of typeRows) bump(summary, t.change_type, t.n);
  return { ...rowToMeta(r), dates, summary, changeCount: countRow.n, totalScenes: sceneRow.n };
}

export function getVersionSummary(versionId: number): AuditVersionSummary | null {
  const r = db.prepare('SELECT * FROM schedule_audit_versions WHERE id = ?').get(versionId) as
    | VersionRow
    | undefined;
  return r ? summaryOfVersion(r) : null;
}

export function listAuditVersions(): AuditListResult {
  const baseline = db
    .prepare('SELECT id FROM schedule_audit_versions WHERE is_baseline = 1 ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  const latest = db
    .prepare('SELECT id FROM schedule_audit_versions ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  const rows = db
    .prepare('SELECT * FROM schedule_audit_versions ORDER BY id DESC')
    .all() as VersionRow[];

  // 漂移检测：当前工作区输入指纹与最新版本是否一致
  let drift = false;
  if (latest) {
    const latestRow = db
      .prepare('SELECT input_hash FROM schedule_audit_versions WHERE id = ?')
      .get(latest.id) as { input_hash: string };
    drift = latestRow.input_hash !== currentInputHash();
  }

  return {
    baselineId: baseline?.id ?? null,
    latestId: latest?.id ?? null,
    drift,
    versions: rows.map(summaryOfVersion),
  };
}

function loadChanges(versionId: number): AuditChange[] {
  const rows = db
    .prepare('SELECT * FROM schedule_audit_changes WHERE version_id = ? ORDER BY sort_order, id')
    .all(versionId) as {
    id: number;
    scene_id: number;
    scene_title: string;
    story_index: number;
    change_type: AuditChangeType;
    reasons: string;
    from_date: string;
    to_date: string;
    from_ordinal: number | null;
    to_ordinal: number | null;
    from_locked: number;
    to_locked: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    sceneId: r.scene_id,
    sceneTitle: r.scene_title,
    storyIndex: r.story_index,
    changeType: r.change_type,
    reasons: (JSON.parse(r.reasons || '[]') as AuditReason[]) ?? [],
    fromDate: r.from_date,
    toDate: r.to_date,
    fromOrdinal: r.from_ordinal,
    toOrdinal: r.to_ordinal,
    fromLocked: r.from_locked === 1,
    toLocked: r.to_locked === 1,
  }));
}

function buildDetail(baseSnapshot: AuditSnapshot | null, targetSnapshot: AuditSnapshot, storedChanges: AuditChange[] | null,
  baseMeta: AuditVersionMeta | null, targetMeta: AuditVersionMeta | null, compareMode: boolean): AuditDetailDto {
  let changes: AuditChange[];
  let summary: AuditSummary;
  let dateStats: AuditDateStat[];
  let unchanged: AuditDetailDto['unchanged'];

  if (storedChanges) {
    changes = storedChanges;
    summary = emptySummary();
    for (const c of changes) bump(summary, c.changeType);
    dateStats = buildDateStats(baseSnapshot ?? { ...targetSnapshot, items: [] }, targetSnapshot);
    const changedIds = new Set(changes.map((c) => c.sceneId));
    unchanged = targetSnapshot.items
      .filter((it) => !changedIds.has(it.sceneId))
      .map((it) => ({
        sceneId: it.sceneId,
        sceneTitle: it.sceneTitle,
        storyIndex: it.storyIndex,
        date: it.date,
        ordinal: it.ordinal,
        locked: it.locked,
      }));
  } else {
    const d = diffSnapshots(baseSnapshot!, targetSnapshot);
    changes = d.changes;
    summary = d.summary;
    dateStats = d.dateStats;
    unchanged = d.unchanged;
  }

  return {
    baseVersion: baseMeta,
    targetVersion: targetMeta,
    compareMode,
    summary,
    dateStats,
    totalScenesBefore: baseSnapshot ? baseSnapshot.items.filter((i) => i.dayIndex >= 0).length : 0,
    totalScenesAfter: targetSnapshot.items.filter((i) => i.dayIndex >= 0).length,
    changes,
    unchanged,
  };
}

/** 查看某版本的完整变更详情（相对其保存时的基准版本） */
export function getAuditDetail(versionId: number): AuditDetailDto | null {
  const target = db
    .prepare('SELECT * FROM schedule_audit_versions WHERE id = ?')
    .get(versionId) as VersionRow | undefined;
  if (!target) return null;
  const targetSnapshot = loadSnapshot(versionId)!;
  let baseSnapshot: AuditSnapshot | null = null;
  let baseMeta: AuditVersionMeta | null = null;
  if (target.base_version_id) {
    const base = db
      .prepare('SELECT * FROM schedule_audit_versions WHERE id = ?')
      .get(target.base_version_id) as VersionRow | undefined;
    if (base) {
      baseSnapshot = loadSnapshot(base.id)!;
      baseMeta = rowToMeta(base);
    }
  }
  return buildDetail(baseSnapshot, targetSnapshot, loadChanges(versionId), baseMeta, rowToMeta(target), false);
}

/**
 * 任意两版即时比较（不落库）：fromVersionId -> toVersionId。
 */
export function compareAuditVersions(fromVersionId: number, toVersionId: number): AuditDetailDto | null {
  const from = db
    .prepare('SELECT * FROM schedule_audit_versions WHERE id = ?')
    .get(fromVersionId) as VersionRow | undefined;
  const to = db
    .prepare('SELECT * FROM schedule_audit_versions WHERE id = ?')
    .get(toVersionId) as VersionRow | undefined;
  if (!from || !to) return null;
  return buildDetail(
    loadSnapshot(from.id)!,
    loadSnapshot(to.id)!,
    null,
    rowToMeta(from),
    rowToMeta(to),
    true
  );
}

/** 将指定版本标记为基线（同时清除旧基线）；之后的新版本均与该基线比较 */
export function setBaseline(versionId: number): AuditVersionSummary {
  const row = db
    .prepare('SELECT id FROM schedule_audit_versions WHERE id = ?')
    .get(versionId) as { id: number } | undefined;
  if (!row) throw new Error('审计版本不存在');
  db.transaction(() => {
    db.prepare('UPDATE schedule_audit_versions SET is_baseline = 0').run();
    db.prepare('UPDATE schedule_audit_versions SET is_baseline = 1 WHERE id = ?').run(versionId);
  })();
  return getVersionSummary(versionId)!;
}
