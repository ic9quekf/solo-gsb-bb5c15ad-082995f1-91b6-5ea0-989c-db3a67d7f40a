import { Router, type Request, type Response } from 'express';
import { db, isValidDateISO } from './db.js';
import { computeContinuity } from './engine.js';
import { computeSchedule, computeStoryOrder, getScheduleSettings } from './schedule.js';
import { PrereqValidationError, assertPrereqsValid, computeShotList } from './shots.js';

export const api = Router();

/* ---------------------------------- 工具 ---------------------------------- */

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

function requireStr(v: unknown, name: string, max = 200): string {
  const s = str(v);
  if (!s) throw new HttpError(400, `${name} 不能为空`);
  if (s.length > max) throw new HttpError(400, `${name} 过长（>${max}）`);
  return s;
}

function idParam(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '非法的 id');
  return id;
}

/** 包装同步路由，统一错误处理 */
const h =
  (fn: (req: Request, res: Response) => void) =>
  (req: Request, res: Response): void => {
    try {
      fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        res
          .status(e.status)
          .json(e.details ? { error: e.message, ...e.details } : { error: e.message });
      } else if (e instanceof PrereqValidationError) {
        // 前置关系校验失败：返回可按镜头编号定位的闭环路径等结构化信息
        res.status(400).json({ error: e.message, code: e.code, ...e.details });
      } else {
        console.error(e);
        res.status(500).json({ error: '服务器内部错误' });
      }
    }
  };

/* --------------------------------- 序列化 --------------------------------- */

interface EntityRow {
  id: number;
  name: string;
  kind: string;
  description: string;
}
interface FieldRow {
  id: number;
  entity_id: number;
  field_key: string;
  label: string;
  initial_value: string;
  sort_order: number;
}
interface SceneRow {
  id: number;
  title: string;
  story_time: string;
  seq: number;
  description: string;
  location: string;
  est_minutes: number;
  min_story_index: number;
}

/** 全量场景的故事序号映射（按 story_time, seq, id 排序后从 1 编号） */
function storyIndexMap(): Map<number, number> {
  const rows = db
    .prepare('SELECT id, story_time, seq FROM scenes')
    .all() as { id: number; story_time: string; seq: number }[];
  return computeStoryOrder(rows);
}

function entityDto(row: EntityRow) {
  const fields = db
    .prepare('SELECT * FROM entity_fields WHERE entity_id = ? ORDER BY sort_order, id')
    .all(row.id) as unknown as FieldRow[];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    fields: fields.map((f) => ({
      id: f.id,
      entityId: f.entity_id,
      key: f.field_key,
      label: f.label,
      initialValue: f.initial_value,
      sortOrder: f.sort_order,
    })),
  };
}

function sceneDto(row: SceneRow, storyIndex: number) {
  const snapshots = db
    .prepare('SELECT * FROM snapshots WHERE scene_id = ?')
    .all(row.id) as unknown as {
    entity_id: number;
    field_key: string;
    expected_value: string;
  }[];
  const changes = db
    .prepare('SELECT * FROM changes WHERE scene_id = ? ORDER BY id')
    .all(row.id) as unknown as {
    id: number;
    entity_id: number;
    field_key: string;
    value: string;
    note: string;
  }[];
  return {
    id: row.id,
    title: row.title,
    storyTime: row.story_time,
    seq: row.seq,
    description: row.description,
    location: row.location,
    estMinutes: row.est_minutes,
    minStoryIndex: row.min_story_index,
    storyIndex,
    snapshots: snapshots.map((s) => ({
      entityId: s.entity_id,
      fieldKey: s.field_key,
      expectedValue: s.expected_value,
    })),
    changes: changes.map((c) => ({
      id: c.id,
      entityId: c.entity_id,
      fieldKey: c.field_key,
      value: c.value,
      note: c.note,
    })),
  };
}

/* ------------------------------ 对象与状态字段 ----------------------------- */

api.get(
  '/entities',
  h((_req, res) => {
    const rows = db
      .prepare('SELECT * FROM entities ORDER BY id')
      .all() as unknown as EntityRow[];
    res.json(rows.map(entityDto));
  })
);

interface FieldInput {
  id?: number;
  key: string;
  label: string;
  initialValue: string;
}

function parseFields(raw: unknown): FieldInput[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'fields 必须是数组');
  const seen = new Set<string>();
  return raw.map((f, i) => {
    const key = requireStr((f as Record<string, unknown>).key, `字段[${i}].key`, 50);
    if (seen.has(key)) throw new HttpError(400, `字段 key 重复：${key}`);
    seen.add(key);
    return {
      id: num((f as Record<string, unknown>).id, 0) || undefined,
      key,
      label: requireStr((f as Record<string, unknown>).label, `字段[${i}].label`, 50),
      initialValue: str((f as Record<string, unknown>).initialValue).slice(0, 200),
    };
  });
}

function parseEntityBody(req: Request) {
  const kind = str(req.body?.kind) || 'character';
  if (kind !== 'character' && kind !== 'prop') {
    throw new HttpError(400, "kind 只能是 'character' 或 'prop'");
  }
  return {
    name: requireStr(req.body?.name, '对象名称'),
    kind,
    description: str(req.body?.description).slice(0, 500),
    fields: parseFields(req.body?.fields ?? []),
  };
}

api.post(
  '/entities',
  h((req, res) => {
    const body = parseEntityBody(req);
    const created = db.transaction(() => {
      const id = db
        .prepare('INSERT INTO entities (name, kind, description) VALUES (?, ?, ?)')
        .run(body.name, body.kind, body.description).lastInsertRowid as number;
      const ins = db.prepare(
        'INSERT INTO entity_fields (entity_id, field_key, label, initial_value, sort_order) VALUES (?, ?, ?, ?, ?)'
      );
      body.fields.forEach((f, i) => ins.run(id, f.key, f.label, f.initialValue, i + 1));
      return id;
    })();
    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(created) as EntityRow;
    res.status(201).json(entityDto(row));
  })
);

api.put(
  '/entities/:id',
  h((req, res) => {
    const id = idParam(req);
    const body = parseEntityBody(req);
    db.transaction(() => {
      const r = db
        .prepare('UPDATE entities SET name = ?, kind = ?, description = ? WHERE id = ?')
        .run(body.name, body.kind, body.description, id);
      if (r.changes === 0) throw new HttpError(404, '对象不存在');

      const existing = db
        .prepare('SELECT * FROM entity_fields WHERE entity_id = ?')
        .all(id) as unknown as FieldRow[];
      const byId = new Map(existing.map((f) => [f.id, f]));
      const keepIds = new Set(body.fields.filter((f) => f.id).map((f) => f.id as number));

      // 删除被移除的字段，并清理其快照与变更记录
      for (const old of existing) {
        if (!keepIds.has(old.id)) {
          db.prepare('DELETE FROM snapshots WHERE entity_id = ? AND field_key = ?').run(id, old.field_key);
          db.prepare('DELETE FROM changes WHERE entity_id = ? AND field_key = ?').run(id, old.field_key);
          db.prepare('DELETE FROM entity_fields WHERE id = ?').run(old.id);
        }
      }

      body.fields.forEach((f, i) => {
        if (f.id && byId.has(f.id)) {
          const old = byId.get(f.id)!;
          if (old.field_key !== f.key) {
            // key 变更时同步迁移历史数据
            db.prepare('UPDATE snapshots SET field_key = ? WHERE entity_id = ? AND field_key = ?').run(f.key, id, old.field_key);
            db.prepare('UPDATE changes SET field_key = ? WHERE entity_id = ? AND field_key = ?').run(f.key, id, old.field_key);
          }
          db.prepare(
            'UPDATE entity_fields SET field_key = ?, label = ?, initial_value = ?, sort_order = ? WHERE id = ?'
          ).run(f.key, f.label, f.initialValue, i + 1, f.id);
        } else {
          db.prepare(
            'INSERT INTO entity_fields (entity_id, field_key, label, initial_value, sort_order) VALUES (?, ?, ?, ?, ?)'
          ).run(id, f.key, f.label, f.initialValue, i + 1);
        }
      });
    })();
    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow;
    res.json(entityDto(row));
  })
);

api.delete(
  '/entities/:id',
  h((req, res) => {
    const id = idParam(req);
    const r = db.prepare('DELETE FROM entities WHERE id = ?').run(id);
    if (r.changes === 0) throw new HttpError(404, '对象不存在');
    res.json({ ok: true });
  })
);

/* --------------------------------- 场景 --------------------------------- */

function parseSceneBody(req: Request) {
  const location = str(req.body?.location).slice(0, 100);
  let estMinutes = num(req.body?.estMinutes, 30);
  if (estMinutes < 1) estMinutes = 1;
  if (estMinutes > 100000) estMinutes = 100000;
  let minStoryIndex = num(req.body?.minStoryIndex, 0);
  if (minStoryIndex < 0) minStoryIndex = 0;
  return {
    title: requireStr(req.body?.title, '场景标题'),
    storyTime: requireStr(req.body?.storyTime, '故事时间', 50),
    seq: num(req.body?.seq, 0),
    description: str(req.body?.description).slice(0, 500),
    location,
    estMinutes,
    minStoryIndex,
  };
}

api.get(
  '/scenes',
  h((_req, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM scenes ORDER BY story_time ASC, seq ASC, id ASC`
      )
      .all() as unknown as SceneRow[];
    const order = storyIndexMap();
    res.json(rows.map((r) => sceneDto(r, order.get(r.id)!)));
  })
);

api.post(
  '/scenes',
  h((req, res) => {
    const b = parseSceneBody(req);
    // 预估新场景的故事序号：排在它之前（story_time, seq 更小）的现有场景数 + 1
    const before = db
      .prepare(
        `SELECT COUNT(*) AS n FROM scenes
         WHERE story_time < ? OR (story_time = ? AND seq < ?)`
      )
      .get(b.storyTime, b.storyTime, b.seq) as { n: number };
    const ownIndex = before.n + 1;
    if (b.minStoryIndex >= ownIndex) {
      throw new HttpError(
        400,
        `不可早于的故事序号必须小于本场自身的故事序号（本场将为故事 #${ownIndex}）`
      );
    }
    const id = db
      .prepare(
        `INSERT INTO scenes (title, story_time, seq, description, location, est_minutes, min_story_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(b.title, b.storyTime, b.seq, b.description, b.location, b.estMinutes, b.minStoryIndex)
      .lastInsertRowid as number;
    const row = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow;
    res.status(201).json(sceneDto(row, ownIndex));
  })
);

api.put(
  '/scenes/:id',
  h((req, res) => {
    const id = idParam(req);
    const b = parseSceneBody(req);
    db.transaction(() => {
      const r = db
        .prepare(
          `UPDATE scenes SET title = ?, story_time = ?, seq = ?, description = ?,
             location = ?, est_minutes = ?, min_story_index = ? WHERE id = ?`
        )
        .run(b.title, b.storyTime, b.seq, b.description, b.location, b.estMinutes, b.minStoryIndex, id);
      if (r.changes === 0) throw new HttpError(404, '场景不存在');
    })();
    const ownIndex = storyIndexMap().get(id);
    if (ownIndex !== undefined && b.minStoryIndex >= ownIndex) {
      throw new HttpError(
        400,
        `不可早于的故事序号必须小于本场自身的故事序号（本场为故事 #${ownIndex}）`
      );
    }
    const row = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow;
    res.json(sceneDto(row, ownIndex ?? 0));
  })
);

api.delete(
  '/scenes/:id',
  h((req, res) => {
    const id = idParam(req);
    const r = db.prepare('DELETE FROM scenes WHERE id = ?').run(id);
    if (r.changes === 0) throw new HttpError(404, '场景不存在');
    res.json({ ok: true });
  })
);

interface SnapshotEntryInput {
  entityId: number;
  fieldKey: string;
  expectedValue: string;
}

/** 整体替换某场景的期望快照（空字符串视为「不校验」，不入库） */
api.put(
  '/scenes/:id/snapshot',
  h((req, res) => {
    const id = idParam(req);
    const entries = (Array.isArray(req.body?.entries) ? req.body.entries : []) as Record<
      string,
      unknown
    >[];
    db.transaction(() => {
      const exists = db.prepare('SELECT id FROM scenes WHERE id = ?').get(id);
      if (!exists) throw new HttpError(404, '场景不存在');
      db.prepare('DELETE FROM snapshots WHERE scene_id = ?').run(id);
      const ins = db.prepare(
        'INSERT INTO snapshots (scene_id, entity_id, field_key, expected_value) VALUES (?, ?, ?, ?)'
      );
      for (const e of entries) {
        const entityId = num(e.entityId);
        const fieldKey = str(e.fieldKey);
        const expectedValue = str(e.expectedValue);
        if (!entityId || !fieldKey || expectedValue === '') continue;
        ins.run(id, entityId, fieldKey, expectedValue.slice(0, 200));
      }
    })();
    const row = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow;
    res.json(sceneDto(row, storyIndexMap().get(id)!));
  })
);

/** 整体替换某场景结束后的显式变更列表 */
api.put(
  '/scenes/:id/changes',
  h((req, res) => {
    const id = idParam(req);
    const entries = (Array.isArray(req.body?.entries) ? req.body.entries : []) as Record<
      string,
      unknown
    >[];
    db.transaction(() => {
      const exists = db.prepare('SELECT id FROM scenes WHERE id = ?').get(id);
      if (!exists) throw new HttpError(404, '场景不存在');
      db.prepare('DELETE FROM changes WHERE scene_id = ?').run(id);
      const ins = db.prepare(
        'INSERT INTO changes (scene_id, entity_id, field_key, value, note) VALUES (?, ?, ?, ?, ?)'
      );
      for (const e of entries) {
        const entityId = num(e.entityId);
        const fieldKey = str(e.fieldKey);
        if (!entityId || !fieldKey) continue;
        ins.run(id, entityId, fieldKey, str(e.value).slice(0, 200), str(e.note).slice(0, 200));
      }
    })();
    const row = db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow;
    res.json(sceneDto(row, storyIndexMap().get(id)!));
  })
);

/* ------------------------------ 连续性校验结果 ----------------------------- */

api.get(
  '/continuity',
  h((req, res) => {
    const report = computeContinuity();
    const entityId = num(req.query.entityId, 0);
    if (entityId > 0) {
      res.json({
        ...report,
        timeline: report.timeline.map((t) => ({
          ...t,
          checks: t.checks.filter((c) => c.entityId === entityId),
          changes: t.changes.filter((c) => c.entityId === entityId),
          conflictCount: t.checks.filter((c) => c.entityId === entityId && !c.match).length,
        })),
        conflicts: report.conflicts.filter((c) => c.entityId === entityId),
      });
      return;
    }
    res.json(report);
  })
);

/* ------------------------------ 现场拍摄排程 ----------------------------- */

/** 读取排程（确定性现算：故事顺序约束 + 锁定场次 + 同地点合并优先） */
api.get(
  '/schedule',
  h((_req, res) => {
    res.json(computeSchedule());
  })
);

/** 读取排程设置（拍摄日期列表 + 单日预计分钟数） */
api.get(
  '/schedule/settings',
  h((_req, res) => {
    res.json(getScheduleSettings());
  })
);

/** 更新排程设置（整体替换拍摄日期；随后重算排程） */
api.put(
  '/schedule/settings',
  h((req, res) => {
    let dayMinutes = num(req.body?.dayMinutes, 480);
    if (dayMinutes < 1) throw new HttpError(400, '单日预计分钟数必须 >= 1');
    if (dayMinutes > 100000) throw new HttpError(400, '单日预计分钟数过大');

    const rawDates: unknown[] = Array.isArray(req.body?.dates) ? req.body.dates : [];
    if (rawDates.length > 60) throw new HttpError(400, '拍摄日期过多（>60）');
    const dates: string[] = [];
    const seen = new Set<string>();
    rawDates.forEach((d, i) => {
      const s = str(d);
      if (!s) return;
      if (!isValidDateISO(s)) throw new HttpError(400, `第 ${i + 1} 个日期格式非法（应为 YYYY-MM-DD）`);
      if (seen.has(s)) throw new HttpError(400, `拍摄日期重复：${s}`);
      seen.add(s);
      dates.push(s);
    });
    dates.sort(); // 日期按自然顺序排列，保证确定性

    db.transaction(() => {
      db.prepare('UPDATE schedule_settings SET day_minutes = ? WHERE id = 1').run(dayMinutes);
      db.prepare('DELETE FROM schedule_dates').run();
      const ins = db.prepare('INSERT INTO schedule_dates (date, sort_order) VALUES (?, ?)');
      dates.forEach((d, i) => ins.run(d, i + 1));
    })();

    res.json(getScheduleSettings());
  })
);

/** 锁定场次到某拍摄日的第 ordinal 个位置（随后重算排程） */
api.put(
  '/schedule/:id/lock',
  h((req, res) => {
    const sceneId = idParam(req);
    const date = requireStr(req.body?.date, '拍摄日期', 20);
    if (!isValidDateISO(date)) throw new HttpError(400, '拍摄日期格式非法（应为 YYYY-MM-DD）');
    let ordinal = num(req.body?.ordinal, 0);
    if (ordinal < 1) throw new HttpError(400, '拍摄位置必须 >= 1');
    if (ordinal > 1000) throw new HttpError(400, '拍摄位置过大');

    const exists = db.prepare('SELECT id FROM scenes WHERE id = ?').get(sceneId);
    if (!exists) throw new HttpError(404, '场景不存在');
    const settings = getScheduleSettings();
    if (!settings.dates.includes(date)) {
      throw new HttpError(400, `${date} 不在拍摄日期列表中，请先在排程设置中添加该日期`);
    }
    const conflict = db
      .prepare('SELECT scene_id FROM schedule_locks WHERE date = ? AND ordinal = ? AND scene_id <> ?')
      .get(date, ordinal, sceneId) as { scene_id: number } | undefined;
    if (conflict) {
      throw new HttpError(409, `${date} 第 ${ordinal} 位已被另一场次锁定，请先解锁该位置或换一个位置`);
    }

    db.prepare(
      `INSERT INTO schedule_locks (scene_id, date, ordinal) VALUES (?, ?, ?)
       ON CONFLICT(scene_id) DO UPDATE SET date = excluded.date, ordinal = excluded.ordinal, locked_at = datetime('now')`
    ).run(sceneId, date, ordinal);

    res.json(computeSchedule());
  })
);

/** 解锁场次（随后重算排程） */
api.delete(
  '/schedule/:id/lock',
  h((req, res) => {
    const sceneId = idParam(req);
    db.prepare('DELETE FROM schedule_locks WHERE scene_id = ?').run(sceneId);
    res.json(computeSchedule());
  })
);

/* -------------------------------- 镜头清单 -------------------------------- */

/**
 * 镜头清单：镜头（编号/景别/机位/必拍/备注）+ 多次拍摄结果（条）。
 * 镜头状态与场景完成度由服务端现算（见 shots.ts），所有写操作均返回最新清单，
 * 前端保存后即可即时刷新；本模块不触碰快照/变更/排程数据。
 */

api.get(
  '/shots',
  h((req, res) => {
    res.json(computeShotList(num(req.query.sceneId, 0)));
  })
);

function parseShotBody(req: Request) {
  return {
    shotNo: requireStr(req.body?.shotNo, '镜头编号', 50),
    framing: str(req.body?.framing).slice(0, 50),
    camera: str(req.body?.camera).slice(0, 50),
    required: req.body?.required === false || req.body?.required === 0 ? 0 : 1,
    note: str(req.body?.note).slice(0, 200),
  };
}

/**
 * 解析请求中的前置镜头 id 列表（prerequisiteShotIds）。
 * 去重、必须为正整数；同场景/自依赖/成环校验在事务内由 assertPrereqsValid 完成。
 */
function parsePrereqIds(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'prerequisiteShotIds 必须是数组');
  if (raw.length > 500) throw new HttpError(400, '前置镜头数量过多（>500）');
  const ids: number[] = [];
  for (const v of raw) {
    const n = num(v, NaN);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '前置镜头 id 非法');
    ids.push(n);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** 整体替换某镜头的前置关系（调用方需保证已在事务内且先通过 assertPrereqsValid） */
function replaceShotPrereqs(shotId: number, prereqIds: number[]): void {
  db.prepare('DELETE FROM shot_prereqs WHERE shot_id = ?').run(shotId);
  const ins = db.prepare('INSERT INTO shot_prereqs (shot_id, prereq_shot_id) VALUES (?, ?)');
  for (const pid of prereqIds) ins.run(shotId, pid);
}

api.post(
  '/scenes/:id/shots',
  h((req, res) => {
    const sceneId = idParam(req);
    const b = parseShotBody(req);
    const prereqIds = parsePrereqIds(req.body?.prerequisiteShotIds);
    // 整个创建+前置写入在同一事务：校验失败（含环）时镜头本身也不会留下
    db.transaction(() => {
      const exists = db.prepare('SELECT id FROM scenes WHERE id = ?').get(sceneId);
      if (!exists) throw new HttpError(404, '场景不存在');
      const maxOrder = db
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM shots WHERE scene_id = ?')
        .get(sceneId) as { m: number };
      const id = db
        .prepare(
          'INSERT INTO shots (scene_id, shot_no, framing, camera, required, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(sceneId, b.shotNo, b.framing, b.camera, b.required, b.note, maxOrder.m + 1)
        .lastInsertRowid as number;
      assertPrereqsValid(id, prereqIds);
      replaceShotPrereqs(id, prereqIds);
    })();
    res.status(201).json(computeShotList());
  })
);

api.put(
  '/shots/:id',
  h((req, res) => {
    const id = idParam(req);
    const b = parseShotBody(req);
    const hasPrereqField = req.body && Object.prototype.hasOwnProperty.call(req.body, 'prerequisiteShotIds');
    const prereqIds = hasPrereqField ? parsePrereqIds(req.body.prerequisiteShotIds) : null;
    // 校验与写入同一事务：自依赖/环被拒绝时，镜头字段与旧前置关系都不会被部分写入
    db.transaction(() => {
      const r = db
        .prepare('UPDATE shots SET shot_no = ?, framing = ?, camera = ?, required = ?, note = ? WHERE id = ?')
        .run(b.shotNo, b.framing, b.camera, b.required, b.note, id);
      if (r.changes === 0) throw new HttpError(404, '镜头不存在');
      if (prereqIds !== null) {
        assertPrereqsValid(id, prereqIds);
        replaceShotPrereqs(id, prereqIds);
      }
    })();
    res.json(computeShotList());
  })
);

api.delete(
  '/shots/:id',
  h((req, res) => {
    const id = idParam(req);
    db.transaction(() => {
      const r = db.prepare('DELETE FROM shots WHERE id = ?').run(id);
      if (r.changes === 0) throw new HttpError(404, '镜头不存在');
      // 同步清理依赖（出边随 shots 外键级联；入边依赖本表外键级联，这里再显式清理一次双保险）
      db.prepare('DELETE FROM shot_prereqs WHERE shot_id = ? OR prereq_shot_id = ?').run(id, id);
    })();
    res.json(computeShotList());
  })
);

/** 登记一条拍摄结果（条号在该镜头内自动递增） */
api.post(
  '/shots/:id/takes',
  h((req, res) => {
    const shotId = idParam(req);
    const exists = db.prepare('SELECT id FROM shots WHERE id = ?').get(shotId);
    if (!exists) throw new HttpError(404, '镜头不存在');
    const usable = req.body?.usable === false || req.body?.usable === 0 ? 0 : 1;
    const note = str(req.body?.note).slice(0, 200);
    const maxNo = db
      .prepare('SELECT COALESCE(MAX(take_no), 0) AS m FROM takes WHERE shot_id = ?')
      .get(shotId) as { m: number };
    db.prepare('INSERT INTO takes (shot_id, take_no, usable, is_best, note) VALUES (?, ?, ?, 0, ?)').run(
      shotId,
      maxNo.m + 1,
      usable,
      note
    );
    res.status(201).json(computeShotList());
  })
);

api.put(
  '/takes/:id',
  h((req, res) => {
    const id = idParam(req);
    const exists = db.prepare('SELECT id FROM takes WHERE id = ?').get(id);
    if (!exists) throw new HttpError(404, '拍摄条不存在');
    const usable = req.body?.usable === false || req.body?.usable === 0 ? 0 : 1;
    const note = str(req.body?.note).slice(0, 200);
    db.prepare('UPDATE takes SET usable = ?, note = ? WHERE id = ?').run(usable, note, id);
    res.json(computeShotList());
  })
);

api.delete(
  '/takes/:id',
  h((req, res) => {
    const id = idParam(req);
    const r = db.prepare('DELETE FROM takes WHERE id = ?').run(id);
    if (r.changes === 0) throw new HttpError(404, '拍摄条不存在');
    res.json(computeShotList());
  })
);

/** 选定/取消「最佳条」（每个镜头至多一条；takeId = 0 表示取消选择） */
api.put(
  '/shots/:id/best',
  h((req, res) => {
    const shotId = idParam(req);
    const takeId = num(req.body?.takeId, 0);
    const shot = db.prepare('SELECT id FROM shots WHERE id = ?').get(shotId);
    if (!shot) throw new HttpError(404, '镜头不存在');
    db.transaction(() => {
      db.prepare('UPDATE takes SET is_best = 0 WHERE shot_id = ?').run(shotId);
      if (takeId > 0) {
        const r = db
          .prepare('UPDATE takes SET is_best = 1 WHERE id = ? AND shot_id = ?')
          .run(takeId, shotId);
        if (r.changes === 0) throw new HttpError(404, '拍摄条不存在或不属于该镜头');
      }
    })();
    res.json(computeShotList());
  })
);
