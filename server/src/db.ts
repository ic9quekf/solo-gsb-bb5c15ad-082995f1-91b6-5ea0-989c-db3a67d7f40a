import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath =
  process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'continuity.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db: Database.Database = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** 本地时区的 YYYY-MM-DD（确定性：只用于给全新库生成默认拍摄日期） */
export function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateISO(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && localDateISO(d) === s;
}

/** 默认排程设置：从明天起连续 3 个拍摄日，每日 480 分钟（8 小时） */
export function defaultScheduleSettings(): { shootDates: string[]; dayMinutes: number } {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const shootDates: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    shootDates.push(localDateISO(d));
  }
  return { shootDates, dayMinutes: 480 };
}

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'character',  -- 'character' | 'prop'
      description TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entity_fields (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      field_key     TEXT NOT NULL,
      label         TEXT NOT NULL,
      initial_value TEXT NOT NULL DEFAULT '',
      sort_order    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (entity_id, field_key)
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      story_time  TEXT NOT NULL,               -- 故事时间，可排序字符串，如 'D01 21:00'
      seq         INTEGER NOT NULL DEFAULT 0,  -- 同刻序号：同一故事时间内的先后
      description TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 期望快照：某场景开拍前，某对象某字段应有的值
    CREATE TABLE IF NOT EXISTS snapshots (
      scene_id       INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      field_key      TEXT NOT NULL,
      expected_value TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (scene_id, entity_id, field_key)
    );

    -- 显式状态变更：某场景结束后生效
    CREATE TABLE IF NOT EXISTS changes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id  INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      value     TEXT NOT NULL DEFAULT '',
      note      TEXT NOT NULL DEFAULT ''
    );

    -- 现场拍摄排程的设置（单行，id 恒为 1）
    CREATE TABLE IF NOT EXISTS schedule_settings (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      day_minutes INTEGER NOT NULL DEFAULT 480  -- 每个拍摄日预计可用分钟数
    );

    -- 拍摄日期（有序）
    CREATE TABLE IF NOT EXISTS schedule_dates (
      date       TEXT PRIMARY KEY,             -- YYYY-MM-DD
      sort_order INTEGER NOT NULL
    );

    -- 用户锁定的场次：锁定到某个拍摄日的第 ordinal 个拍摄位置
    CREATE TABLE IF NOT EXISTS schedule_locks (
      scene_id INTEGER PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
      date     TEXT NOT NULL,
      ordinal  INTEGER NOT NULL,
      locked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 镜头清单：每个场景的镜头（编号 / 景别 / 机位 / 是否必拍 / 备注）
    CREATE TABLE IF NOT EXISTS shots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      shot_no    TEXT NOT NULL,               -- 镜头编号，如 '1'、'2A'
      framing    TEXT NOT NULL DEFAULT '',    -- 景别：远景/全景/中景/近景/特写…
      camera     TEXT NOT NULL DEFAULT '',    -- 机位：A 机/手持/轨道…
      required   INTEGER NOT NULL DEFAULT 1,  -- 是否必拍镜头
      note       TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 拍摄结果（条）：一个镜头可登记多条；is_best 标记「最佳条」
    CREATE TABLE IF NOT EXISTS takes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      shot_id    INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      take_no    INTEGER NOT NULL,            -- 第几条（镜头内从 1 递增）
      usable     INTEGER NOT NULL DEFAULT 1,  -- 本条是否可用（0 = NG）
      is_best    INTEGER NOT NULL DEFAULT 0,  -- 是否最佳条（每个镜头至多一条）
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 前置镜头：shot_id 必须在所有 prereq_shot_id 都有可用最佳条后才进入可拍状态；
    -- 仅允许同场景内的依赖；自依赖与任意深度环由服务端在保存前拒绝。
    CREATE TABLE IF NOT EXISTS shot_prereqs (
      shot_id        INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      prereq_shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      PRIMARY KEY (shot_id, prereq_shot_id),
      CHECK (shot_id <> prereq_shot_id)
    );

    CREATE INDEX IF NOT EXISTS idx_scenes_order   ON scenes (story_time, seq, id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_scene ON snapshots (scene_id);
    CREATE INDEX IF NOT EXISTS idx_changes_scene  ON changes (scene_id);
    CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes (entity_id);
    CREATE INDEX IF NOT EXISTS idx_locks_date     ON schedule_locks (date, ordinal);
    CREATE INDEX IF NOT EXISTS idx_shots_scene    ON shots (scene_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_takes_shot     ON takes (shot_id, take_no);
    CREATE INDEX IF NOT EXISTS idx_prereqs_prereq ON shot_prereqs (prereq_shot_id);
  `);

  // 旧库升级：为 scenes 增补排程字段（全新库由建表直接包含）
  const sceneCols = db.prepare('PRAGMA table_info(scenes)').all() as { name: string }[];
  const has = (name: string) => sceneCols.some((c) => c.name === name);
  if (!has('location')) {
    db.exec("ALTER TABLE scenes ADD COLUMN location TEXT NOT NULL DEFAULT ''");
  }
  if (!has('est_minutes')) {
    // 预计拍摄分钟数
    db.exec('ALTER TABLE scenes ADD COLUMN est_minutes INTEGER NOT NULL DEFAULT 30');
  }
  if (!has('min_story_index')) {
    // 不可提前的故事序号：本场只能在故事线第 1..N 场全部拍完之后拍摄；0 = 无约束
    db.exec('ALTER TABLE scenes ADD COLUMN min_story_index INTEGER NOT NULL DEFAULT 0');
  }

  // 首次启动：写入默认拍摄日期与单日时长
  const settingsRow = db.prepare('SELECT id FROM schedule_settings WHERE id = 1').get();
  if (!settingsRow) {
    const def = defaultScheduleSettings();
    db.prepare('INSERT INTO schedule_settings (id, day_minutes) VALUES (1, ?)').run(def.dayMinutes);
    const insDate = db.prepare('INSERT INTO schedule_dates (date, sort_order) VALUES (?, ?)');
    def.shootDates.forEach((date, i) => insDate.run(date, i + 1));
  }
}

/** 首次启动时写入一份演示数据（含两处刻意制造的连续性冲突），便于打开即见效果。 */
export function seedIfEmpty(): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number };
  if (row.n > 0) return;

  const seed = db.transaction(() => {
    const insEntity = db.prepare(
      'INSERT INTO entities (name, kind, description) VALUES (?, ?, ?)'
    );
    const insField = db.prepare(
      'INSERT INTO entity_fields (entity_id, field_key, label, initial_value, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    const insScene = db.prepare(
      `INSERT INTO scenes (title, story_time, seq, description, location, est_minutes, min_story_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insSnap = db.prepare(
      'INSERT INTO snapshots (scene_id, entity_id, field_key, expected_value) VALUES (?, ?, ?, ?)'
    );
    const insChange = db.prepare(
      'INSERT INTO changes (scene_id, entity_id, field_key, value, note) VALUES (?, ?, ?, ?, ?)'
    );
    const insLock = db.prepare(
      'INSERT INTO schedule_locks (scene_id, date, ordinal) VALUES (?, ?, ?)'
    );
    const insShot = db.prepare(
      'INSERT INTO shots (scene_id, shot_no, framing, camera, required, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insTake = db.prepare(
      'INSERT INTO takes (shot_id, take_no, usable, is_best, note) VALUES (?, ?, ?, ?, ?)'
    );
    const insPrereq = db.prepare(
      'INSERT INTO shot_prereqs (shot_id, prereq_shot_id) VALUES (?, ?)'
    );

    const lin = insEntity.run('林雪', 'character', '女主角').lastInsertRowid as number;
    insField.run(lin, 'costume', '服装', '蓝色风衣', 1);
    insField.run(lin, 'left_hand', '左手伤势', '无', 2);
    insField.run(lin, 'mood', '情绪', '平静', 3);

    const chen = insEntity.run('陈默', 'character', '男主角').lastInsertRowid as number;
    insField.run(chen, 'costume', '服装', '灰色西装', 1);
    insField.run(chen, 'glasses', '眼镜', '戴着', 2);

    const watch = insEntity.run('旧怀表', 'prop', '关键道具').lastInsertRowid as number;
    insField.run(watch, 'lid', '表盖', '合上', 1);
    insField.run(watch, 'hands', '指针', '停在 3:07', 2);

    // 故事线顺序（storyIndex）由 (story_time, seq) 决定，与拍摄排程完全独立
    const s1 = insScene.run(
      '雨夜公寓', 'D01 21:00', 1, '林雪独自回到公寓',
      'A 棚 · 公寓内景', 90, 0
    ).lastInsertRowid as number;
    insSnap.run(s1, lin, 'costume', '蓝色风衣');
    insSnap.run(s1, watch, 'lid', '合上');
    insChange.run(s1, watch, 'lid', '打开', '林雪打开怀表看照片');
    insChange.run(s1, lin, 'mood', '崩溃', '看到照片后情绪崩溃');

    const s2 = insScene.run(
      '医院走廊', 'D02 08:30', 1, '次日清晨',
      'B 棚 · 医院走廊', 60, 0
    ).lastInsertRowid as number;
    insSnap.run(s2, lin, 'costume', '蓝色风衣');
    insSnap.run(s2, lin, 'left_hand', '无');
    insSnap.run(s2, watch, 'lid', '打开');
    insChange.run(s2, lin, 'left_hand', '包扎', '摔倒被玻璃划伤');
    insChange.run(s2, watch, 'hands', '停在 4:15', '怀表被摔，指针走动后停住');

    const s3 = insScene.run(
      '天台对峙', 'D02 18:00', 1, '两人摊牌',
      'C 场地 · 天台', 120, 0
    ).lastInsertRowid as number;
    insSnap.run(s3, lin, 'left_hand', '包扎');
    insSnap.run(s3, chen, 'glasses', '戴着');
    // 刻意的冲突：上一场已把指针改为 4:15，这里仍按旧剧本写 3:07
    insSnap.run(s3, watch, 'hands', '停在 3:07');
    insChange.run(s3, chen, 'glasses', '摘下', '陈默摘下眼镜');

    const s4 = insScene.run(
      '码头告别', 'D03 06:00', 1, '清晨告别',
      'D 场地 · 江边码头', 75, 0
    ).lastInsertRowid as number;
    insSnap.run(s4, chen, 'glasses', '摘下');
    // 刻意的冲突：林雪情绪自 S1 起为「崩溃」，此处快照误写「平静」
    insSnap.run(s4, lin, 'mood', '平静');
    insChange.run(s4, watch, 'lid', '合上', '林雪合上怀表放进兜里');

    // 追加两场，用于演示「同地点合并」与「故事顺序约束阻断合并」
    const s5 = insScene.run(
      '公寓闪回（童年）', 'D00 15:00', 1, '插叙：童年记忆（故事最早，常被放到后面拍）',
      'A 棚 · 公寓内景', 45, 2
    ).lastInsertRowid as number;
    insSnap.run(s5, lin, 'costume', '蓝色风衣');

    const s6 = insScene.run(
      '码头尾声（多年后）', 'D05 10:00', 1, '尾声，多年后重回码头',
      'D 场地 · 江边码头', 60, 4
    ).lastInsertRowid as number;
    insSnap.run(s6, watch, 'lid', '合上');

    // 演示镜头清单：覆盖「已拍 / 待拍 / 需重拍 / 缺镜头」四种状态
    // 雨夜公寓：镜头 1 已拍（最佳条=第 2 条）；镜头 2 有可用条但未选最佳条（需重拍）；镜头 3 待拍
    const s1sh1 = insShot.run(s1, '1', '全景', 'A 机 · 固定', 1, '开场建立镜头', 1).lastInsertRowid as number;
    insTake.run(s1sh1, 1, 0, 0, '穿帮：窗外出现工作人员');
    insTake.run(s1sh1, 2, 1, 1, '表演到位，选为最佳条');
    const s1sh2 = insShot.run(s1, '2', '特写', '手持', 1, '怀表特写，注意焦点', 2).lastInsertRowid as number;
    insTake.run(s1sh2, 1, 1, 0, '可用，但导演尚未选定最佳条');
    const s1sh3 = insShot.run(s1, '3', '中景', 'B 机 · 轨道', 0, '氛围补拍镜头（非必拍）', 3).lastInsertRowid as number;

    // 演示前置镜头与可拍队列：
    // 镜头 4（必拍）前置为镜头 1、3；镜头 3 待拍，故镜头 4 被阻塞且不出现在可拍队列；
    // 镜头 5（必拍）前置为镜头 4（链式阻塞）；镜头 6（必拍）无前置 → 本批可拍队列中按编号排序。
    const s1sh4 = insShot.run(s1, '4', '近景', 'A 机 · 固定', 1, '林雪进门后的反应镜头（前置：1、3）', 4).lastInsertRowid as number;
    const s1sh5 = insShot.run(s1, '5', '特写', '手持', 1, '怀表落入掌心（前置：4，链式阻塞）', 5).lastInsertRowid as number;
    insShot.run(s1, '6', '中景', 'B 机 · 固定', 1, '房间环境交代镜头（无前置，可直接拍）', 6);
    insPrereq.run(s1sh4, s1sh1);
    insPrereq.run(s1sh4, s1sh3);
    insPrereq.run(s1sh5, s1sh4);

    // 医院走廊：两个必拍镜头均已有可用最佳条 → 场景完成
    const s2sh1 = insShot.run(s2, '1', '全景', 'A 机 · 固定', 1, '', 1).lastInsertRowid as number;
    insTake.run(s2sh1, 1, 1, 1, '一条过');
    const s2sh2 = insShot.run(s2, '2', '近景', '轨道', 1, '林雪摔倒', 2).lastInsertRowid as number;
    insTake.run(s2sh2, 1, 1, 1, '');
    insTake.run(s2sh2, 2, 0, 0, '群演走位错误');

    // 天台对峙：唯一必拍镜头的唯一一条 NG → 需重拍
    const s3sh1 = insShot.run(s3, '1', '大全景', '无人机', 1, '黄昏逆光', 1).lastInsertRowid as number;
    insTake.run(s3sh1, 1, 0, 0, '风大画面晃动，不可用');

    // 码头告别 / 公寓闪回 / 码头尾声：未建镜头 → 列表中突出「缺镜头」

    // 演示锁定：天台对峙锁定在第 2 个拍摄日的第 1 个位置
    const dates = db
      .prepare('SELECT date FROM schedule_dates ORDER BY sort_order')
      .all() as { date: string }[];
    if (dates[1]) insLock.run(s3, dates[1].date, 1);
  });

  seed();
  console.log('[db] 已写入演示数据（设置 SEED_DEMO=0 可关闭）');
}
