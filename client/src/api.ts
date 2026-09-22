/* ---------------------------- 与后端共享的数据类型 ---------------------------- */

export interface EntityField {
  id: number;
  entityId: number;
  key: string;
  label: string;
  initialValue: string;
  sortOrder: number;
}

export interface Entity {
  id: number;
  name: string;
  kind: 'character' | 'prop';
  description: string;
  fields: EntityField[];
}

export interface SnapshotEntry {
  entityId: number;
  fieldKey: string;
  expectedValue: string;
}

export interface ChangeEntry {
  id: number;
  entityId: number;
  fieldKey: string;
  value: string;
  note: string;
}

export interface Scene {
  id: number;
  title: string;
  storyTime: string;
  seq: number;
  description: string;
  location: string;
  estMinutes: number;
  minStoryIndex: number;
  storyIndex: number;
  snapshots: SnapshotEntry[];
  changes: ChangeEntry[];
}

export interface SourceRef {
  sceneId: number | null;
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
  source: SourceRef;
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
  scene: {
    id: number;
    title: string;
    storyTime: string;
    seq: number;
    description: string;
  };
  checks: Check[];
  changes: AppliedChange[];
  conflictCount: number;
}

export interface Conflict extends Check {
  sceneId: number;
  sceneTitle: string;
  storyTime: string;
  seq: number;
  firstDivergence: boolean;
}

export interface ContinuityReport {
  generatedAt: string;
  timeline: TimelineItem[];
  conflicts: Conflict[];
}

/* ----------------------------- 现场拍摄排程 ----------------------------- */

export interface ScheduleItem {
  sceneId: number;
  title: string;
  storyTime: string;
  seq: number;
  storyIndex: number;
  location: string;
  estMinutes: number;
  minStoryIndex: number;
  locked: boolean;
  ordinal: number;
  startMinute: number;
  endMinute: number;
  merged: boolean;
  overflow: boolean;
  orderViolation: boolean;
}

export interface ScheduleEvent {
  ordinal: number;
  type: 'start' | 'switch' | 'day-continue' | 'note';
  fromLocation: string;
  toLocation: string;
  reason: string;
}

export type ScheduleConflictType =
  | 'capacity-overflow'
  | 'order-violation'
  | 'lock-order'
  | 'lock-overlap'
  | 'lock-invalid-date';

export interface ScheduleConflict {
  type: ScheduleConflictType;
  dayIndex: number;
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
  items: ScheduleItem[];
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

export interface ScheduleSettings {
  dayMinutes: number;
  dates: string[];
}

/* ------------------------------- 镜头清单 ------------------------------- */

export type ShotStatus = 'pending' | 'done' | 'reshoot';
export type ReshootReason = 'no-best' | 'best-ng' | 'all-ng';

export interface TakeItem {
  id: number;
  shotId: number;
  takeNo: number;
  usable: boolean;
  isBest: boolean;
  note: string;
}

/** 单项前置阻塞原因 */
export interface ShotBlocker {
  prereqShotId: number;
  prereqShotNo: string;
  prereqStatus: ShotStatus;
  blockedByChain: boolean;
  message: string;
}

export interface ReadyQueueItem {
  id: number;
  shotNo: string;
  required: boolean;
  status: ShotStatus;
}

export interface ShotItem {
  id: number;
  sceneId: number;
  shotNo: string;
  framing: string;
  camera: string;
  required: boolean;
  note: string;
  status: ShotStatus;
  reshootReason: ReshootReason | null;
  bestTakeId: number | null;
  /** 前置镜头 id 列表（同场景内） */
  prerequisiteShotIds: number[];
  /** 可拍 = 全部前置镜头均有可用最佳条（无前置即可拍） */
  filmable: boolean;
  /** 未满足的前置逐项阻塞原因 */
  blockers: ShotBlocker[];
  takes: TakeItem[];
}

export interface SceneShots {
  sceneId: number;
  title: string;
  storyTime: string;
  seq: number;
  storyIndex: number;
  totalShots: number;
  requiredShots: number;
  doneShots: number;
  requiredDone: number;
  pendingShots: number;
  reshootShots: number;
  /** 可拍且尚未完成的镜头数 */
  readyShots: number;
  completion: number;
  complete: boolean;
  /** 下一批可拍镜头（必拍优先、编号自然序） */
  readyQueue: ReadyQueueItem[];
  shots: ShotItem[];
}

export interface ShotListReport {
  generatedAt: string;
  scenes: SceneShots[];
  totals: {
    scenes: number;
    completeScenes: number;
    scenesWithoutShots: number;
    shots: number;
    requiredShots: number;
    doneShots: number;
    requiredDone: number;
    pendingShots: number;
    reshootShots: number;
    readyShots: number;
  };
}

export interface ShotPayload {
  shotNo: string;
  framing: string;
  camera: string;
  required: boolean;
  note: string;
  /** 前置镜头 id 列表（必须全部为同场景镜头；服务端拒绝自依赖与任意深度环） */
  prerequisiteShotIds?: number[];
}

/* --------------------------------- 请求封装 --------------------------------- */

async function req<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface EntityPayload {
  name: string;
  kind: string;
  description: string;
  fields: { id?: number; key: string; label: string; initialValue: string }[];
}

export interface ScenePayload {
  title: string;
  storyTime: string;
  seq: number;
  description: string;
  location: string;
  estMinutes: number;
  minStoryIndex: number;
}

export const api = {
  listEntities: () => req<Entity[]>('/api/entities'),
  createEntity: (p: EntityPayload) =>
    req<Entity>('/api/entities', { method: 'POST', body: JSON.stringify(p) }),
  updateEntity: (id: number, p: EntityPayload) =>
    req<Entity>(`/api/entities/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteEntity: (id: number) => req<{ ok: true }>(`/api/entities/${id}`, { method: 'DELETE' }),

  listScenes: () => req<Scene[]>('/api/scenes'),
  createScene: (p: ScenePayload) =>
    req<Scene>('/api/scenes', { method: 'POST', body: JSON.stringify(p) }),
  updateScene: (id: number, p: ScenePayload) =>
    req<Scene>(`/api/scenes/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteScene: (id: number) => req<{ ok: true }>(`/api/scenes/${id}`, { method: 'DELETE' }),

  saveSnapshot: (id: number, entries: SnapshotEntry[]) =>
    req<Scene>(`/api/scenes/${id}/snapshot`, { method: 'PUT', body: JSON.stringify({ entries }) }),
  saveChanges: (id: number, entries: Omit<ChangeEntry, 'id'>[]) =>
    req<Scene>(`/api/scenes/${id}/changes`, { method: 'PUT', body: JSON.stringify({ entries }) }),

  continuity: (entityId?: number) =>
    req<ContinuityReport>(`/api/continuity${entityId ? `?entityId=${entityId}` : ''}`),

  schedule: () => req<ScheduleReport>('/api/schedule'),
  scheduleSettings: () => req<ScheduleSettings>('/api/schedule/settings'),
  updateScheduleSettings: (p: ScheduleSettings) =>
    req<ScheduleSettings>('/api/schedule/settings', {
      method: 'PUT',
      body: JSON.stringify(p),
    }),
  lockScene: (id: number, date: string, ordinal: number) =>
    req<ScheduleReport>(`/api/schedule/${id}/lock`, {
      method: 'PUT',
      body: JSON.stringify({ date, ordinal }),
    }),
  unlockScene: (id: number) =>
    req<ScheduleReport>(`/api/schedule/${id}/lock`, { method: 'DELETE' }),

  shotList: (sceneId?: number) =>
    req<ShotListReport>(`/api/shots${sceneId ? `?sceneId=${sceneId}` : ''}`),
  createShot: (sceneId: number, p: ShotPayload) =>
    req<ShotListReport>(`/api/scenes/${sceneId}/shots`, {
      method: 'POST',
      body: JSON.stringify(p),
    }),
  updateShot: (id: number, p: ShotPayload) =>
    req<ShotListReport>(`/api/shots/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteShot: (id: number) => req<ShotListReport>(`/api/shots/${id}`, { method: 'DELETE' }),

  addTake: (shotId: number, usable: boolean, note: string) =>
    req<ShotListReport>(`/api/shots/${shotId}/takes`, {
      method: 'POST',
      body: JSON.stringify({ usable, note }),
    }),
  updateTake: (id: number, usable: boolean, note: string) =>
    req<ShotListReport>(`/api/takes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ usable, note }),
    }),
  deleteTake: (id: number) => req<ShotListReport>(`/api/takes/${id}`, { method: 'DELETE' }),
  setBestTake: (shotId: number, takeId: number) =>
    req<ShotListReport>(`/api/shots/${shotId}/best`, {
      method: 'PUT',
      body: JSON.stringify({ takeId }),
    }),
};
