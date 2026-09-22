import { db } from './db.js';

/* ================================ 数据类型 ================================ */

export interface SchedScene {
  id: number;
  title: string;
  storyTime: string;
  seq: number;
  location: string;
  estMinutes: number;
  minStoryIndex: number; // 0 = 无约束
}

export interface SchedItem {
  sceneId: number;
  title: string;
  storyTime: string;
  seq: number;
  storyIndex: number;
  location: string;
  estMinutes: number;
  minStoryIndex: number;
  locked: boolean;
  ordinal: number; // 当日拍摄位置（从 1 开始）
  startMinute: number;
  endMinute: number;
  merged: boolean; // 与上一场同地点（本日内合并，无切换）
  overflow: boolean; // 超出当日预计时长
  orderViolation: boolean; // 实际违反了故事顺序约束
}

export type ScheduleEventType = 'start' | 'switch' | 'day-continue' | 'note';

/** 放置关系：'none' = 与上一场同地点（合并，不产生事件） */
type PlaceKind = ScheduleEventType | 'none';

export interface ScheduleEvent {
  ordinal: number; // 事件发生时即将拍摄的位置
  type: ScheduleEventType;
  fromLocation: string;
  toLocation: string;
  reason: string;
}

export type ScheduleConflictType =
  | 'capacity-overflow' // 拍摄日总时长超限
  | 'order-violation' // 实际排程违反故事顺序
  | 'lock-order' // 锁定场次与其故事顺序约束冲突
  | 'lock-overlap' // 同一拍摄日同一位置锁定了多个场次
  | 'lock-invalid-date'; // 锁定到了拍摄日期列表之外

export interface ScheduleConflict {
  type: ScheduleConflictType;
  dayIndex: number; // -1 = 不属于任何拍摄日
  date: string;
  ordinal: number;
  sceneId: number;
  sceneTitle: string;
  relatedSceneId: number | null;
  relatedSceneTitle: string;
  message: string;
}

export interface ScheduleDay {
  dayIndex: number;
  date: string;
  dayMinutes: number;
  items: SchedItem[];
  events: ScheduleEvent[];
  plannedMinutes: number;
  lockedMinutes: number;
  switchCount: number;
  mergeCount: number;
  overflow: boolean;
}

export interface ScheduleReport {
  generatedAt: string;
  settings: { dayMinutes: number; dates: string[] };
  days: ScheduleDay[];
  conflicts: ScheduleConflict[];
  totalSwitches: number;
  totalMerges: number;
  unscheduledCount: number;
}

/* ================================ 工具函数 ================================ */

interface SceneRow {
  id: number;
  title: string;
  story_time: string;
  seq: number;
  location: string;
  est_minutes: number;
  min_story_index: number;
}

interface LockRow {
  scene_id: number;
  date: string;
  ordinal: number;
}

/** 故事序号：按 (story_time, seq, id) 排序后从 1 开始编号——与连续性引擎的重放顺序严格一致 */
export function computeStoryOrder(scenes: Pick<SceneRow, 'id' | 'story_time' | 'seq'>[]): Map<number, number> {
  const sorted = [...scenes].sort((a, b) =>
    a.story_time < b.story_time
      ? -1
      : a.story_time > b.story_time
        ? 1
        : a.seq - b.seq || a.id - b.id
  );
  const map = new Map<number, number>();
  sorted.forEach((s, i) => map.set(s.id, i + 1));
  return map;
}

export function getScheduleSettings(): { dayMinutes: number; dates: string[] } {
  let row = db.prepare('SELECT day_minutes FROM schedule_settings WHERE id = 1').get() as
    | { day_minutes: number }
    | undefined;
  if (!row) {
    // 理论上 migrate() 已写入；这里兜底保证幂等
    db.prepare('INSERT INTO schedule_settings (id, day_minutes) VALUES (1, 480)').run();
    row = { day_minutes: 480 };
  }
  const dates = (
    db.prepare('SELECT date FROM schedule_dates ORDER BY sort_order ASC').all() as { date: string }[]
  ).map((d) => d.date);
  return { dayMinutes: row.day_minutes, dates };
}

const locName = (s: SchedScene) => s.location || '（未填写地点）';

/* ================================ 排程引擎 ================================ */

/**
 * 现场拍摄排程（纯函数式现算，结果确定）：
 * 1. 故事序号 = 场景按 (story_time, seq, id) 的排名；minStoryIndex>0 表示
 *    「故事线第 1..N 场全部拍完后本场才能拍」，构成拍摄先后约束（DAG）；
 * 2. 锁定场次先固定到「拍摄日 + 当日位置」，锁定之间的顺序冲突先做静态检查；
 * 3. 逐日、逐空位贪心填充：可拍（前置故事已完成）的候选中，优先当前地点同地点场景
 *    （合并、零切换）；必须切换时，选择「能连续拍同地点场次最多」的地点，
 *    所有并列均按故事序号/地点名/场景 id 确定地打破；
 * 4. 每次地点切换、跨日继续、无法合并/无法排入的原因都记录为可展示事件，
 *    容量超限与顺序违约记录为冲突；排不完的场次确定性地追加到最后一个拍摄日。
 *
 * 不读取也不修改 snapshots/changes，连续性故事时间线不受影响。
 */
export function computeSchedule(): ScheduleReport {
  const rows = db
    .prepare(
      `SELECT id, title, story_time, seq, location, est_minutes, min_story_index
       FROM scenes ORDER BY story_time ASC, seq ASC, id ASC`
    )
    .all() as SceneRow[];

  const settings = getScheduleSettings();
  const locks = db.prepare('SELECT scene_id, date, ordinal FROM schedule_locks').all() as LockRow[];
  const scenes: SchedScene[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    storyTime: r.story_time,
    seq: r.seq,
    location: r.location.trim(),
    estMinutes: r.est_minutes,
    minStoryIndex: r.min_story_index,
  }));
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const storyIndex = computeStoryOrder(rows);

  const conflicts = new Map<string, ScheduleConflict>();
  const addConflict = (c: ScheduleConflict) => {
    const key = `${c.type}|${c.sceneId}|${c.relatedSceneId ?? ''}`;
    if (!conflicts.has(key)) conflicts.set(key, c);
  };

  /* ---------------- 锁定数据校验：失效日期 / 同位置重叠 ---------------- */

  interface Anchor {
    scene: SchedScene;
    date: string;
    dayIndex: number;
    ordinal: number;
    orderViolation: boolean;
  }
  const anchors: Anchor[] = [];
  const dateIndex = new Map(settings.dates.map((d, i) => [d, i]));
  const occupied = new Set<string>(); // `${dayIndex}|${ordinal}`

  for (const lk of locks) {
    const scene = byId.get(lk.scene_id);
    if (!scene) continue; // 场景已删除（外键级联后通常不会出现）
    const di = dateIndex.get(lk.date);
    if (di === undefined) {
      addConflict({
        type: 'lock-invalid-date',
        dayIndex: -1,
        date: lk.date,
        ordinal: lk.ordinal,
        sceneId: scene.id,
        sceneTitle: scene.title,
        relatedSceneId: null,
        relatedSceneTitle: '',
        message: `「${scene.title}」锁定在 ${lk.date} 第 ${lk.ordinal} 位，但该日期不在当前拍摄日期列表中，锁定被忽略；请重新锁定或补回该日期。`,
      });
      continue;
    }
    const pos = `${di}|${lk.ordinal}`;
    if (occupied.has(pos)) {
      addConflict({
        type: 'lock-overlap',
        dayIndex: di,
        date: lk.date,
        ordinal: lk.ordinal,
        sceneId: scene.id,
        sceneTitle: scene.title,
        relatedSceneId: null,
        relatedSceneTitle: '',
        message: `「${scene.title}」的锁定与另一锁定场次冲突：${lk.date} 第 ${lk.ordinal} 位只能有一个锁定场次，本次锁定被忽略。`,
      });
      continue;
    }
    occupied.add(pos);
    anchors.push({ scene, date: lk.date, dayIndex: di, ordinal: lk.ordinal, orderViolation: false });
  }

  /* ---------------- 锁定之间的故事顺序静态检查 ---------------- */

  const ordered = [...anchors].sort((a, b) =>
    a.dayIndex !== b.dayIndex ? a.dayIndex - b.dayIndex : a.ordinal - b.ordinal
  );
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (a.scene.minStoryIndex <= 0) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j]; // b 在 a 之后拍
      const idxB = storyIndex.get(b.scene.id)!;
      if (idxB <= a.scene.minStoryIndex) {
        a.orderViolation = true;
        b.orderViolation = true;
        addConflict({
          type: 'lock-order',
          dayIndex: a.dayIndex,
          date: a.date,
          ordinal: a.ordinal,
          sceneId: a.scene.id,
          sceneTitle: a.scene.title,
          relatedSceneId: b.scene.id,
          relatedSceneTitle: b.scene.title,
          message:
            `锁定冲突：「${a.scene.title}」要求故事 #1～#${a.scene.minStoryIndex} 全部先拍，` +
            `但「${b.scene.title}」（故事 #${idxB}）被锁定排在其后（${b.date} 第 ${b.ordinal} 位）。`,
        });
      }
    }
  }

  /* ---------------- 初始化拍摄日 ---------------- */

  const days: ScheduleDay[] = settings.dates.map((date, dayIndex) => ({
    dayIndex,
    date,
    dayMinutes: settings.dayMinutes,
    items: [],
    events: [],
    plannedMinutes: 0,
    lockedMinutes: 0,
    switchCount: 0,
    mergeCount: 0,
    overflow: false,
  }));

  const unscheduled = new Set<SchedScene>(scenes);
  const lockedIds = new Set(anchors.map((a) => a.scene.id));
  const placed = new Set<number>();
  const predecessorsDone = (s: SchedScene) => {
    for (const p of scenes) {
      if (p.id === s.id) continue;
      if ((storyIndex.get(p.id) ?? 0) <= s.minStoryIndex && !placed.has(p.id)) return false;
    }
    return true;
  };
  const predList = (s: SchedScene) =>
    scenes
      .filter((p) => p.id !== s.id && (storyIndex.get(p.id) ?? 0) <= s.minStoryIndex)
      .sort((a, b) => (storyIndex.get(a.id)! - storyIndex.get(b.id)!));
  const names = (list: SchedScene[]) => list.map((p) => `「${p.title}」(#${storyIndex.get(p.id)})`).join('、');

  let curLoc = ''; // 上一个已排场景的地点（跨日保留）
  let totalSwitches = 0;

  const emit = (
    day: ScheduleDay,
    ordinal: number,
    type: ScheduleEventType,
    toLocation: string,
    reason: string
  ) => {
    day.events.push({ ordinal, type, fromLocation: curLoc, toLocation, reason });
    if (type === 'switch') {
      day.switchCount += 1;
      totalSwitches += 1;
    }
  };

  const place = (
    day: ScheduleDay,
    s: SchedScene,
    ordinal: number,
    locked: boolean,
    switchType: PlaceKind,
    reason: string
  ): SchedItem => {
    const startMinute = day.plannedMinutes;
    const endMinute = startMinute + s.estMinutes;
    const merged = switchType === 'none';
    if (switchType !== 'none') emit(day, ordinal, switchType, locName(s), reason);
    const item: SchedItem = {
      sceneId: s.id,
      title: s.title,
      storyTime: s.storyTime,
      seq: s.seq,
      storyIndex: storyIndex.get(s.id)!,
      location: s.location,
      estMinutes: s.estMinutes,
      minStoryIndex: s.minStoryIndex,
      locked,
      ordinal,
      startMinute,
      endMinute,
      merged,
      overflow: endMinute > day.dayMinutes,
      orderViolation: false,
    };
    day.items.push(item);
    day.plannedMinutes = endMinute;
    if (locked) day.lockedMinutes += s.estMinutes;
    if (merged) day.mergeCount += 1;
    if (item.overflow) day.overflow = true;
    placed.add(s.id);
    unscheduled.delete(s);
    curLoc = s.location;
    return item;
  };

  /* ---------------- 贪心选场：优先合并同地点，否则选可连续拍摄最多的地点 ---------------- */

  interface Choice {
    scene: SchedScene;
    reason: string; // 选择（含切换）原因
  }
  interface NoChoice {
    reason: string; // 本段无法继续填充的原因
    wait?: boolean; // 为等待同地点伙伴（未来锚点）而主动提前结束本日
  }

  /**
   * 单场切换的「孤立风险」：现在拍它会离开该地点，而它还有同地点伙伴要等
   * 「更晚拍摄日」的锁定锚点之后才能解锁 —— 现在拍会白白多一次往返切换。
   * 保守判定：伙伴本身锁定在更晚日，或其未满足的前置故事锁定在更晚日。
   */
  const strandCompanions = (s: SchedScene, dayIndex: number): SchedScene[] => {
    const waitPredsLater = (p: SchedScene): boolean => {
      if (anchors.some((a) => a.scene.id === p.id && a.dayIndex > dayIndex)) return true;
      return predList(p).some(
        (q) => !placed.has(q.id) && anchors.some((a) => a.scene.id === q.id && a.dayIndex > dayIndex)
      );
    };
    return scenes.filter(
      (p) =>
        p.id !== s.id &&
        p.location === s.location &&
        unscheduled.has(p) &&
        !predecessorsDone(p) &&
        // 伙伴不会在本日锚点出现，只能在更晚日解锁
        !anchors.some((a) => a.scene.id === p.id && a.dayIndex === dayIndex) &&
        waitPredsLater(p)
    );
  };

  const chooseScene = (
    day: ScheduleDay,
    dayAnchors: Set<number>,
    minuteLeft: number,
    dayHasItem: boolean,
    canWait: boolean
  ): Choice | NoChoice | null => {
    const remaining = scenes.filter((s) => unscheduled.has(s) && !lockedIds.has(s.id));
    const eligible = remaining.filter((s) => predecessorsDone(s));
    const fits = (s: SchedScene) => !dayHasItem || s.estMinutes <= minuteLeft;

    const blockersFor = (list: SchedScene[], includeAnchors: Set<number>): SchedScene[] => {
      const out: SchedScene[] = [];
      for (const s of list) {
        if (lockedIds.has(s.id)) continue; // 锁定场次统一在下方按锚点处理
        if (!predecessorsDone(s)) out.push(s);
      }
      // 指定的、当日尚未排入的锁定场次也会挡住合并
      for (const id of includeAnchors) {
        const a = byId.get(id)!;
        if (unscheduled.has(a)) out.push(a);
      }
      return out;
    };

    // 1) 当前地点还有可拍、装得下的同地点场景 => 合并
    if (curLoc) {
      const sameAvail = eligible.filter((s) => s.location === curLoc);
      const sameFit = sameAvail.filter(fits);
      if (sameFit.length > 0) {
        const s = [...sameFit].sort(
          (a, b) => storyIndex.get(a.id)! - storyIndex.get(b.id)! || a.id - b.id
        )[0];
        return { scene: s, reason: `同地点合并：继续在「${curLoc || '未填写地点'}」拍摄，零切换。` };
      }
      if (sameAvail.length > 0) {
        // 同地点还有场但装不下：不能因合并而留在原地（同地点分支不启用「等伙伴」）
        const switchChoice = pickSwitch(eligible, fits, remaining, [
          `同地点还有 ${sameAvail.length} 场（如${names(sameAvail.slice(0, 3))}，需 ${sameAvail[0].estMinutes} 分钟起），超过当日剩余 ${minuteLeft} 分钟，无法继续合并。`,
        ], day.dayIndex, false);
        if (switchChoice) return switchChoice;
        return {
          reason:
            `当日仅剩 ${minuteLeft} 分钟，同地点的${names(sameAvail.slice(0, 3))}（${sameAvail[0].estMinutes} 分钟起）装不下，` +
            `且没有其他可切换的候选。`,
        };
      }
      // 同地点剩余场次被顺序/锁定挡住，或已全部拍完
      const sameLocAnchors = new Set(
        scenes.filter((s) => lockedIds.has(s.id) && s.location === curLoc).map((s) => s.id)
      );
      const stayBlocked = blockersFor(remaining.filter((s) => s.location === curLoc), sameLocAnchors);
      const blockedMsgs: string[] = [];
      const predBlocked = stayBlocked.filter((s) => !lockedIds.has(s.id) && !predecessorsDone(s));
      if (predBlocked.length > 0) {
        blockedMsgs.push(
          `同地点的${names(predBlocked.slice(0, 3))}故事顺序约束未满足（其前置故事尚未拍完），不能合并。`
        );
      }
      const lockedHere = stayBlocked.filter((s) => lockedIds.has(s.id));
      if (lockedHere.length > 0) {
        blockedMsgs.push(
          `同地点的${names(lockedHere.slice(0, 3))}已被锁定在本日更靠后的位置，需按锁定位置拍摄。`
        );
      }
      const switchChoice = pickSwitch(eligible, fits, remaining, blockedMsgs, day.dayIndex, canWait);
      if (switchChoice) return switchChoice;
      if (blockedMsgs.length > 0) return { reason: blockedMsgs.join('') };
      // 落到统一的无可拍分支
    }

    // 2) 无当前地点（拍摄日首段）或需要且可以切换
    const switchChoice = pickSwitch(eligible, fits, remaining, [], day.dayIndex, canWait);
    if (switchChoice) return switchChoice;

    // 3) 无法继续：区分「被顺序/锁定挡住」与「容量不足」
    if (eligible.length > 0) {
      const sample = eligible[0];
      return {
        reason:
          `当日仅剩 ${minuteLeft} 分钟，可拍候选（如${names(eligible.slice(0, 3))}，${sample.estMinutes} 分钟起）均装不下；` +
          `余下场次顺延到后续拍摄日。`,
      };
    }
    const blocked = blockersFor(remaining, dayAnchors);
    if (blocked.length > 0) {
      const pred = blocked.filter((s) => !lockedIds.has(s.id));
      const lockedHere = blocked.filter((s) => lockedIds.has(s.id));
      const parts: string[] = [];
      if (pred.length > 0)
        parts.push(`${names(pred.slice(0, 3))}的故事顺序约束未满足（前置故事还没拍）`);
      if (lockedHere.length > 0) parts.push(`${names(lockedHere.slice(0, 3))}被锁定在本日更靠后位置`);
      return { reason: `剩余场次暂不可拍：${parts.join('；')}。` };
    }
    return null;
  };

  /** 必须切换时选点：可连续拍同地点场次最多（合并潜力最大）的地点，并列时确定地打破 */
  const pickSwitch = (
    eligible: SchedScene[],
    fits: (s: SchedScene) => boolean,
    remaining: SchedScene[],
    prefixReasons: string[],
    dayIndex: number,
    canWait: boolean
  ): Choice | NoChoice | null => {
    const fitEligible = eligible.filter(fits);
    if (fitEligible.length === 0) return null;
    const groups = new Map<string, SchedScene[]>();
    for (const s of fitEligible) {
      const list = groups.get(s.location) ?? [];
      list.push(s);
      groups.set(s.location, list);
    }
    const runFitOf = (loc: string) =>
      // 该地点当前未排、非锁定且装得下的可拍场次数（切换后可连续完成的长度）
      scenes.filter(
        (s) =>
          s.location === loc &&
          unscheduled.has(s) &&
          !lockedIds.has(s.id) &&
          predecessorsDone(s) &&
          fits(s)
      ).length;
    const availOf = (loc: string) =>
      // 该地点剩余的全部非锁定场次（总体合并潜力）
      remaining.filter((s) => s.location === loc).length;
    const firstStoryOf = (loc: string) => {
      const g = groups.get(loc)!;
      return Math.min(...g.map((s) => storyIndex.get(s.id)!));
    };

    const ranked: {
      loc: string;
      run: number;
      avail: number;
      risk: SchedScene[];
    }[] = [];
    for (const loc of [...groups.keys()].sort()) {
      const first = fitEligible
        .filter((s) => s.location === loc)
        .sort((a, b) => storyIndex.get(a.id)! - storyIndex.get(b.id)! || a.id - b.id)[0];
      // 只有「现在只能拍 1 场」时孤立风险才有意义；run>=2 时切换后本就能合并多场
      const risk = runFitOf(loc) === 1 ? strandCompanions(first, dayIndex) : [];
      ranked.push({ loc, run: runFitOf(loc), avail: availOf(loc), risk });
    }
    // 排序：可连拍长度 ↓ → 孤立风险（无风险优先）→ 最早可拍故事序号 ↑ → 总潜力 ↓ → 地点名
    ranked.sort(
      (a, b) =>
        b.run - a.run ||
        (a.risk.length > 0 ? 1 : 0) - (b.risk.length > 0 ? 1 : 0) ||
        firstStoryOf(a.loc) - firstStoryOf(b.loc) ||
        b.avail - a.avail ||
        (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0)
    );
    const best = ranked[0];

    // 「可以等」时：所有候选都有孤立风险，则本日提前收工，把同地点场次留到未来与伙伴合并
    if (canWait && ranked.every((r) => r.risk.length > 0)) {
      const parts = ranked
        .slice(0, 3)
        .map((r) => {
          const first = groups.get(r.loc)![0];
          return `${names([first])}的同地点伙伴${names(r.risk.slice(0, 3))}要等后续拍摄日的锁定场次之后才能拍`;
        });
      return {
        reason:
          `今日尚有容量，但当前可拍的每个地点都只剩单场、且其同地点伙伴受故事顺序约束要等后续拍摄日锁定场次之后才能拍；` +
          `为避免拍了又折返、最小化地点切换，本日提前收工（${parts.join('；')}）。`,
        wait: true,
      };
    }

    const group = groups.get(best.loc)!;
    const s = [...group].sort(
      (a, b) => storyIndex.get(a.id)! - storyIndex.get(b.id)! || a.id - b.id
    )[0];
    const reasonParts = [...prefixReasons];
    if (best.risk.length > 0) {
      reasonParts.push(
        `切换到「${locName(s)}」：该地点现在仅可拍 1 场，同地点的${names(best.risk.slice(0, 3))}受故事顺序约束暂不能合并，` +
          `但其他候选同样需要等待，先行拍摄；预计未来回到该地点再拍其余场次。`
      );
    } else {
      reasonParts.push(
        curLoc
          ? `切换到「${locName(s)}」：该地点现在可连续拍摄 ${best.run} 场同地点场景（当前各候选地点中最多），以最小化地点切换。`
          : `从「${locName(s)}」开拍：该地点现在可连续拍摄 ${best.run} 场同地点场景（当前各候选地点中最多），优先集中同地点场景。`
      );
    }
    return { scene: s, reason: reasonParts.join('') };
  };

  /* ---------------- 逐日填充：锁定为锚，锚间空位贪心 ---------------- */

  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    const dayAnchors = anchors
      .filter((a) => a.dayIndex === di)
      .sort((a, b) => a.ordinal - b.ordinal);
    const anchorIds = new Set(dayAnchors.map((a) => a.scene.id));
    let cursor = 1; // 下一个自由位置

    for (const anchor of dayAnchors) {
      // 锚前空位：位置 [cursor, anchor.ordinal)（锚前不启用「等伙伴」，避免越过当日锚点）
      while (cursor < anchor.ordinal) {
        const minuteLeft = day.dayMinutes - day.plannedMinutes;
        const choice = chooseScene(day, anchorIds, minuteLeft, day.items.length > 0, false);
        if (!choice || !('scene' in choice)) {
          if (choice) {
            day.events.push({
              ordinal: cursor,
              type: 'note',
              fromLocation: curLoc,
              toLocation: curLoc,
              reason: choice.reason,
            });
          }
          break;
        }
        place(day, choice.scene, cursor, false, classify(day, choice.scene), choice.reason);
        cursor += 1;
      }

      // 落入锁定锚点
      const s = anchor.scene;
      if (unscheduled.has(s)) {
        const undone = predList(s).filter((p) => !placed.has(p.id));
        if (undone.length > 0) {
          anchor.orderViolation = true;
          for (const p of undone) {
            addConflict({
              type: 'lock-order',
              dayIndex: di,
              date: day.date,
              ordinal: anchor.ordinal,
              sceneId: s.id,
              sceneTitle: s.title,
              relatedSceneId: p.id,
              relatedSceneTitle: p.title,
              message: `锁定冲突：「${s.title}」锁定在 ${day.date} 第 ${anchor.ordinal} 位，但前置故事${names([p])}此时尚未拍摄，锁定安排违反故事顺序约束。`,
            });
          }
        }
        const parts = [`锁定场次：「${s.title}」固定在 ${day.date} 第 ${anchor.ordinal} 位拍摄。`];
        if (undone.length > 0) parts.push(`但其前置故事（${names(undone.slice(0, 3))}）尚未拍完。`);
        const item = place(
          day,
          s,
          anchor.ordinal,
          true,
          classify(day, s),
          parts.join('')
        );
        item.orderViolation = anchor.orderViolation;
        if (item.overflow) {
          addConflict({
            type: 'capacity-overflow',
            dayIndex: di,
            date: day.date,
            ordinal: anchor.ordinal,
            sceneId: s.id,
            sceneTitle: s.title,
            relatedSceneId: null,
            relatedSceneTitle: '',
            message: `容量冲突：锁定场次「${s.title}」（${s.estMinutes} 分钟）排入后，${day.date} 累计 ${day.plannedMinutes} 分钟，超过当日预计 ${day.dayMinutes} 分钟。`,
          });
        }
      }
      cursor = anchor.ordinal + 1;
    }

    // 末锚之后的自由段（非最后一个拍摄日可「等伙伴」提前收工）
    const canWait = di < days.length - 1;
    for (;;) {
      const minuteLeft = day.dayMinutes - day.plannedMinutes;
      const choice = chooseScene(day, anchorIds, minuteLeft, day.items.length > 0, canWait);
      if (!choice) break;
      if (!('scene' in choice)) {
        day.events.push({
          ordinal: cursor,
          type: 'note',
          fromLocation: curLoc,
          toLocation: curLoc,
          reason: choice.reason,
        });
        break;
      }
      place(day, choice.scene, cursor, false, classify(day, choice.scene), choice.reason);
      cursor += 1;
    }

    // 当日容量溢出冲突（自由场次导致的溢出）
    if (day.overflow) {
      for (const it of day.items) {
        if (!it.overflow || it.locked) continue;
        addConflict({
          type: 'capacity-overflow',
          dayIndex: di,
          date: day.date,
          ordinal: it.ordinal,
          sceneId: it.sceneId,
          sceneTitle: it.title,
          relatedSceneId: null,
          relatedSceneTitle: '',
          message: `容量冲突：「${it.title}」（${it.estMinutes} 分钟）排入后，${day.date} 累计将达 ${it.endMinute} 分钟，超过当日预计 ${day.dayMinutes} 分钟。`,
        });
      }
    }
  }

  /** 判断放置某场时与上一场（跨日保留）的关系 */
  function classify(day: ScheduleDay, s: SchedScene): PlaceKind {
    const dayHasItem = day.items.length > 0;
    if (!dayHasItem) {
      if (!curLoc) return 'start';
      if (curLoc === s.location) return 'day-continue';
      return 'switch';
    }
    if (curLoc === s.location) return 'none';
    return 'switch';
  }

  /* ---------------- 排不进任何拍摄日：确定性追加到最后一日 ---------------- */

  let leftovers = scenes
    .filter((s) => unscheduled.has(s))
    .sort((a, b) => storyIndex.get(a.id)! - storyIndex.get(b.id)! || a.id - b.id);

  // 兜底：没有任何拍摄日时，合成一个「未安排拍摄日」承载全部场次并报冲突
  if (days.length === 0 && leftovers.length > 0) {
    days.push({
      dayIndex: -1,
      date: '',
      dayMinutes: settings.dayMinutes,
      items: [],
      events: [],
      plannedMinutes: 0,
      lockedMinutes: 0,
      switchCount: 0,
      mergeCount: 0,
      overflow: false,
    });
    for (const s of leftovers) {
      addConflict({
        type: 'capacity-overflow',
        dayIndex: -1,
        date: '',
        ordinal: 0,
        sceneId: s.id,
        sceneTitle: s.title,
        relatedSceneId: null,
        relatedSceneTitle: '',
        message: `尚未配置任何拍摄日期，「${s.title}」无处可排；请在排程设置中添加拍摄日期后重新计算。`,
      });
    }
    leftovers = [];
  }

  const lastDay = days[days.length - 1];
  let leftoverOrdinal = lastDay ? lastDay.items.length + 1 : 1;
  for (const s of leftovers) {
    if (!lastDay) break; // 理论不可达（上方已兜底）
    const undone = predList(s).filter((p) => placed.has(p.id) === false);
    let type: PlaceKind;
    if (lastDay.items.length === 0) {
      type = !curLoc ? 'start' : curLoc === s.location ? 'day-continue' : 'switch';
    } else {
      type = curLoc === s.location ? 'none' : 'switch';
    }
    const reason =
      undone.length > 0
        ? `拍摄日容量已满且前置故事未拍完：「${s.title}」被强制追加到最后一个拍摄日（违反故事顺序约束，前置：${names(undone.slice(0, 3))}）。`
        : `拍摄日容量不足：「${s.title}」在所有拍摄日的可拍窗口内均装不下，追加到最后一个拍摄日（超出当日预计 ${settings.dayMinutes} 分钟）。`;
    const item = place(lastDay, s, leftoverOrdinal, false, type, reason);
    leftoverOrdinal += 1;
    addConflict({
      type: 'capacity-overflow',
      dayIndex: lastDay.dayIndex,
      date: lastDay.date,
      ordinal: item.ordinal,
      sceneId: s.id,
      sceneTitle: s.title,
      relatedSceneId: null,
      relatedSceneTitle: '',
      message: `容量冲突：所有拍摄日均无法容纳「${s.title}」（${s.estMinutes} 分钟），已追加到 ${lastDay.date}，当日累计 ${lastDay.plannedMinutes} 分钟（预计 ${settings.dayMinutes} 分钟）。请增加拍摄日或提高单日时长。`,
    });
    if (undone.length > 0) {
      item.orderViolation = true;
      for (const p of undone) {
        addConflict({
          type: 'order-violation',
          dayIndex: lastDay.dayIndex,
          date: lastDay.date,
          ordinal: item.ordinal,
          sceneId: s.id,
          sceneTitle: s.title,
          relatedSceneId: p.id,
          relatedSceneTitle: p.title,
          message: `顺序冲突：「${s.title}」（故事 #${storyIndex.get(s.id)}）在前置故事${names([p])}之前拍摄，违反「不可早于故事 #${s.minStoryIndex}」约束。`,
        });
      }
    }
  }

  const totalMerges = days.reduce((n, d) => n + d.mergeCount, 0);
  const conflictArr = [...conflicts.values()].sort((a, b) =>
    a.dayIndex !== b.dayIndex
      ? a.dayIndex - b.dayIndex
      : a.ordinal !== b.ordinal
        ? a.ordinal - b.ordinal
        : a.sceneId - b.sceneId
  );

  return {
    generatedAt: new Date().toISOString(),
    settings: { dayMinutes: settings.dayMinutes, dates: settings.dates },
    days,
    conflicts: conflictArr,
    totalSwitches,
    totalMerges,
    unscheduledCount: leftovers.length,
  };
}
