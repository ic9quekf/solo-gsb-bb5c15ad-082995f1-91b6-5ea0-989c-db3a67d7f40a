import { db } from './db.js';
import { computeStoryOrder } from './schedule.js';

/* ================================ 数据类型 ================================ */

/** 镜头状态：待拍（无任何拍摄条）/ 已拍（有可用最佳条）/ 需重拍（有条但无可用最佳条） */
export type ShotStatus = 'pending' | 'done' | 'reshoot';

/** 需重拍的具体原因（status = 'reshoot' 时有值） */
export type ReshootReason = 'no-best' | 'best-ng' | 'all-ng';

export interface TakeDto {
  id: number;
  shotId: number;
  takeNo: number;
  usable: boolean;
  isBest: boolean;
  note: string;
}

/** 单项前置阻塞原因 */
export interface ShotBlocker {
  /** 阻塞本镜头的前置镜头 id */
  prereqShotId: number;
  /** 前置镜头编号（用于直接定位） */
  prereqShotNo: string;
  /** 前置镜头当前的拍摄状态 */
  prereqStatus: ShotStatus;
  /** 前置是否自身也未满足其前置（链式阻塞） */
  blockedByChain: boolean;
  /** 可直接展示的逐项阻塞原因 */
  message: string;
}

export interface ReadyQueueItem {
  id: number;
  shotNo: string;
  required: boolean;
  status: ShotStatus;
}

export interface ShotDto {
  id: number;
  sceneId: number;
  shotNo: string;
  framing: string; // 景别
  camera: string; // 机位
  required: boolean; // 是否必拍
  note: string;
  status: ShotStatus;
  reshootReason: ReshootReason | null;
  bestTakeId: number | null; // 可用最佳条（status = 'done' 时有值）
  /** 前置镜头 id 列表（同场景内） */
  prerequisiteShotIds: number[];
  /** 可拍 = 全部前置镜头均有可用最佳条（无前置视为可拍）；与镜头自身拍摄状态无关 */
  filmable: boolean;
  /** 未满足的前置逐项阻塞原因（filmable = false 时有值） */
  blockers: ShotBlocker[];
  takes: TakeDto[];
}

export interface SceneShotsDto {
  sceneId: number;
  title: string;
  storyTime: string;
  seq: number;
  storyIndex: number;
  totalShots: number;
  requiredShots: number;
  doneShots: number; // 有可用最佳条的镜头数
  requiredDone: number; // 必拍镜头中已有可用最佳条的数量
  pendingShots: number;
  reshootShots: number;
  /** 可拍（前置已全部就绪）且尚未完成的镜头数 */
  readyShots: number;
  /** 完成度 0..1：有镜头时按「有可用最佳条的镜头 / 总镜头」计；无镜头为 0 */
  completion: number;
  /** 场景完成 = 已建镜头 且 所有必拍镜头均有可用最佳条 */
  complete: boolean;
  /**
   * 下一批可拍镜头：可拍（前置全部有可用最佳条）且尚未完成的镜头，
   * 按「必拍优先、镜头编号自然序」排序（最后以 id 确定打破并列）。
   */
  readyQueue: ReadyQueueItem[];
  shots: ShotDto[];
}

export interface ShotListReport {
  generatedAt: string;
  scenes: SceneShotsDto[];
  totals: {
    scenes: number;
    completeScenes: number;
    scenesWithoutShots: number; // 缺镜头（一个镜头都没建）的场景数
    shots: number;
    requiredShots: number;
    doneShots: number;
    requiredDone: number;
    pendingShots: number;
    reshootShots: number;
    readyShots: number; // 全部场景中可拍且未完成的镜头数
  };
}

/* ================================ 计算 ================================ */

interface ShotRow {
  id: number;
  scene_id: number;
  shot_no: string;
  framing: string;
  camera: string;
  required: number;
  note: string;
  sort_order: number;
}

interface TakeRow {
  id: number;
  shot_id: number;
  take_no: number;
  usable: number;
  is_best: number;
  note: string;
}

/**
 * 镜头编号自然序比较：数字段按数值、其余按字符逐段比较（如 2 < 10、2A < 2B < 10）。
 * 纯字符串兜底保证任意输入都有确定性结果。
 */
export function naturalCompare(a: string, b: string): number {
  const reA = a.match(/\d+|\D+/g) ?? [a];
  const reB = b.match(/\d+|\D+/g) ?? [b];
  const n = Math.min(reA.length, reB.length);
  for (let i = 0; i < n; i++) {
    const x = reA[i];
    const y = reB[i];
    if (/\d/.test(x) && /\d/.test(y)) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      // 数值相同：短串（前导零更少）排前；长度相同即字符串相同
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  if (reA.length !== reB.length) return reA.length < reB.length ? -1 : 1;
  return 0;
}

/** 前置保存校验失败：携带可直接定位的结构化信息（自依赖 / 跨场景 / 环） */
export class PrereqValidationError extends Error {
  constructor(
    public code: 'self-dependency' | 'cross-scene' | 'not-found' | 'cycle',
    message: string,
    public details: { cycleShotIds?: number[]; cycleShotNos?: string[]; cyclePath?: string } = {}
  ) {
    super(message);
  }
}

/**
 * 保存镜头前置关系前的校验（必须在写事务内、写入前调用）：
 * - 所有前置必须存在且与本镜头同场景；
 * - 拒绝自依赖；
 * - 在「假设本次更新已生效」的全量依赖图上做 DFS，检测任意深度环，
 *   并返回能按镜头编号定位的闭环路径（从环上首个镜头出发再回到它）。
 */
export function assertPrereqsValid(shotId: number, nextPrereqIds: number[]): void {
  const shots = db
    .prepare('SELECT id, scene_id, shot_no FROM shots')
    .all() as { id: number; scene_id: number; shot_no: string }[];
  const shotById = new Map(shots.map((s) => [s.id, s]));

  const target = shotById.get(shotId);
  if (!target) throw new PrereqValidationError('not-found', '镜头不存在');

  // 去重（确定性：按 id 升序）
  const prereqIds = [...new Set(nextPrereqIds)].sort((a, b) => a - b);

  for (const pid of prereqIds) {
    if (pid === shotId) {
      throw new PrereqValidationError(
        'self-dependency',
        `镜头「${target.shot_no}」不能把自己设为前置镜头（自依赖）`
      );
    }
    const p = shotById.get(pid);
    if (!p) {
      throw new PrereqValidationError('cross-scene', `前置镜头不存在（id=${pid}），请刷新后重试`);
    }
    if (p.scene_id !== target.scene_id) {
      throw new PrereqValidationError(
        'cross-scene',
        `前置镜头只能选择同一场景内的镜头：镜头「${p.shot_no}」不属于当前场景`
      );
    }
  }

  // 构造「本次更新生效后」的邻接表：shot -> 其前置镜头（按 id 升序，保证确定性）
  const adj = new Map<number, number[]>();
  const rows = db.prepare('SELECT shot_id, prereq_shot_id FROM shot_prereqs').all() as {
    shot_id: number;
    prereq_shot_id: number;
  }[];
  for (const r of rows) {
    if (r.shot_id === shotId) continue; // 目标镜头的旧出边整体替换
    const list = adj.get(r.shot_id) ?? [];
    list.push(r.prereq_shot_id);
    adj.set(r.shot_id, list);
  }
  adj.set(shotId, prereqIds);
  for (const list of adj.values()) list.sort((a, b) => a - b);

  // DFS 找环：从目标镜头沿「前置」边出发，回到当前路径上的节点即为环
  const state = new Map<number, 0 | 1>(); // 0 = 在当前路径上, 1 = 已完成
  const stack: number[] = [];

  const dfs = (node: number): number[] | null => {
    state.set(node, 0);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const st = state.get(next);
      if (st === 0) {
        // 找到环：从 next 在路径中的位置开始，回到 next
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (st === undefined) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 1);
    return null;
  };

  const cycle = dfs(shotId);
  if (cycle) {
    const cycleShotNos = cycle.map((id) => shotById.get(id)?.shot_no ?? `#${id}`);
    const cyclePath = cycleShotNos.map((no) => `镜头 ${no}`).join(' → ');
    throw new PrereqValidationError(
      'cycle',
      `前置镜头存在闭环依赖（任意深度都不允许）：${cyclePath}。请先去掉其中一条前置关系`,
      { cycleShotIds: cycle, cycleShotNos, cyclePath }
    );
  }
}

/**
 * 镜头清单（纯读取现算）：
 * - 镜头状态由拍摄条推导：无条 = 待拍；有可用最佳条 = 已拍；其余 = 需重拍；
 * - 场景完成度按镜头状态与最佳条选择计算；只有所有必拍镜头均有可用最佳条时场景才算完成；
 * - 可拍状态：全部前置镜头都有可用最佳条（无前置即可拍）；否则逐项给出阻塞原因；
 * - 下一批可拍队列按「必拍优先、镜头编号自然序」生成；
 * - 不读取也不修改 snapshots/changes/schedule_*，连续性重放与排程逻辑不受影响。
 */
export function computeShotList(sceneIdFilter = 0): ShotListReport {
  const sceneRows = db
    .prepare('SELECT id, title, story_time, seq FROM scenes ORDER BY story_time ASC, seq ASC, id ASC')
    .all() as { id: number; title: string; story_time: string; seq: number }[];
  const storyIndex = computeStoryOrder(sceneRows);

  const shotRows = db
    .prepare('SELECT * FROM shots ORDER BY scene_id, sort_order, id')
    .all() as unknown as ShotRow[];
  const takeRows = db
    .prepare('SELECT * FROM takes ORDER BY shot_id, take_no, id')
    .all() as unknown as TakeRow[];
  const prereqRows = db
    .prepare('SELECT shot_id, prereq_shot_id FROM shot_prereqs ORDER BY shot_id, prereq_shot_id')
    .all() as { shot_id: number; prereq_shot_id: number }[];

  const takesByShot = new Map<number, TakeDto[]>();
  for (const t of takeRows) {
    const list = takesByShot.get(t.shot_id) ?? [];
    list.push({
      id: t.id,
      shotId: t.shot_id,
      takeNo: t.take_no,
      usable: t.usable === 1,
      isBest: t.is_best === 1,
      note: t.note,
    });
    takesByShot.set(t.shot_id, list);
  }

  // 先算每个镜头的自身拍摄状态（done 等价于「有可用最佳条」）
  const statusById = new Map<number, ShotStatus>();
  for (const s of shotRows) {
    const takes = takesByShot.get(s.id) ?? [];
    const best = takes.find((t) => t.isBest);
    const usableBest = best && best.usable ? best : null;
    if (takes.length === 0) statusById.set(s.id, 'pending');
    else if (usableBest) statusById.set(s.id, 'done');
    else statusById.set(s.id, 'reshoot');
  }

  // 前置邻接（id 升序）
  const prereqsById = new Map<number, number[]>();
  for (const r of prereqRows) {
    const list = prereqsById.get(r.shot_id) ?? [];
    list.push(r.prereq_shot_id);
    prereqsById.set(r.shot_id, list);
  }
  for (const list of prereqsById.values()) list.sort((a, b) => a - b);

  // 前置是否「自身也被阻塞」：沿前置边记忆化（图无环——保存时已拒绝环）
  const filmableCache = new Map<number, boolean>();
  const isFilmable = (id: number): boolean => {
    const cached = filmableCache.get(id);
    if (cached !== undefined) return cached;
    const ok = (prereqsById.get(id) ?? []).every(
      (pid) => statusById.get(pid) === 'done' && isFilmable(pid)
    );
    filmableCache.set(id, ok);
    return ok;
  };

  const shotsByScene = new Map<number, ShotDto[]>();
  const shotNoById = new Map<number, string>(shotRows.map((s) => [s.id, s.shot_no]));

  const RESHOOT_TEXT: Record<ShotStatus, string> = {
    pending: '待拍（尚未登记拍摄条）',
    reshoot: '需重拍（尚无可用最佳条）',
    done: '已拍',
  };

  for (const s of shotRows) {
    const takes = takesByShot.get(s.id) ?? [];
    const best = takes.find((t) => t.isBest);
    const usableBest = best && best.usable ? best : null;
    const status = statusById.get(s.id)!;
    let reshootReason: ReshootReason | null = null;
    if (status === 'reshoot') {
      if (!best) reshootReason = takes.some((t) => t.usable) ? 'no-best' : 'all-ng';
      else reshootReason = 'best-ng';
    }

    const prereqIds = prereqsById.get(s.id) ?? [];
    const blockers: ShotBlocker[] = prereqIds
      .filter((pid) => statusById.get(pid) !== 'done')
      .map((pid) => ({
        prereqShotId: pid,
        prereqShotNo: shotNoById.get(pid) ?? `#${pid}`,
        prereqStatus: statusById.get(pid) ?? 'pending',
        blockedByChain: !isFilmable(pid),
        message: `前置镜头「${shotNoById.get(pid) ?? pid}」${RESHOOT_TEXT[statusById.get(pid) ?? 'pending']}`,
      }));
    const filmable = blockers.length === 0;

    const list = shotsByScene.get(s.scene_id) ?? [];
    list.push({
      id: s.id,
      sceneId: s.scene_id,
      shotNo: s.shot_no,
      framing: s.framing,
      camera: s.camera,
      required: s.required === 1,
      note: s.note,
      status,
      reshootReason,
      bestTakeId: usableBest ? usableBest.id : null,
      prerequisiteShotIds: prereqIds,
      filmable,
      blockers,
      takes,
    });
    shotsByScene.set(s.scene_id, list);
  }

  const totals: ShotListReport['totals'] = {
    scenes: 0,
    completeScenes: 0,
    scenesWithoutShots: 0,
    shots: 0,
    requiredShots: 0,
    doneShots: 0,
    requiredDone: 0,
    pendingShots: 0,
    reshootShots: 0,
    readyShots: 0,
  };

  const scenes: SceneShotsDto[] = [];
  for (const sc of sceneRows) {
    if (sceneIdFilter > 0 && sc.id !== sceneIdFilter) continue;
    const shots = shotsByScene.get(sc.id) ?? [];
    const doneShots = shots.filter((s) => s.status === 'done').length;
    const requiredShots = shots.filter((s) => s.required).length;
    const requiredDone = shots.filter((s) => s.required && s.status === 'done').length;
    const pendingShots = shots.filter((s) => s.status === 'pending').length;
    const reshootShots = shots.filter((s) => s.status === 'reshoot').length;
    const complete = shots.length > 0 && requiredDone === requiredShots;

    // 下一批可拍：前置全部就绪 且 自身尚未完成；必拍优先，编号自然序，id 兜底
    const readyQueue = shots
      .filter((s) => s.filmable && s.status !== 'done')
      .map((s) => ({ id: s.id, shotNo: s.shotNo, required: s.required, status: s.status }))
      .sort((a, b) => {
        if (a.required !== b.required) return a.required ? -1 : 1;
        const cmp = naturalCompare(a.shotNo, b.shotNo);
        if (cmp !== 0) return cmp;
        return a.id - b.id;
      });

    scenes.push({
      sceneId: sc.id,
      title: sc.title,
      storyTime: sc.story_time,
      seq: sc.seq,
      storyIndex: storyIndex.get(sc.id)!,
      totalShots: shots.length,
      requiredShots,
      doneShots,
      requiredDone,
      pendingShots,
      reshootShots,
      readyShots: readyQueue.length,
      completion: shots.length > 0 ? doneShots / shots.length : 0,
      complete,
      readyQueue,
      shots,
    });

    totals.scenes += 1;
    if (complete) totals.completeScenes += 1;
    if (shots.length === 0) totals.scenesWithoutShots += 1;
    totals.shots += shots.length;
    totals.requiredShots += requiredShots;
    totals.doneShots += doneShots;
    totals.requiredDone += requiredDone;
    totals.pendingShots += pendingShots;
    totals.reshootShots += reshootShots;
    totals.readyShots += readyQueue.length;
  }

  return { generatedAt: new Date().toISOString(), scenes, totals };
}
