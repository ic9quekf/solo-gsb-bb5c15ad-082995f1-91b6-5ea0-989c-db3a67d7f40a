import { useEffect, useState } from 'react';
import {
  api,
  type ReshootReason,
  type SceneShots,
  type ShotItem,
  type ShotListReport,
  type ShotStatus,
  type TakeItem,
} from '../api';

interface Props {
  shotList: ShotListReport | null;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

const STATUS_LABEL: Record<ShotStatus, string> = {
  pending: '待拍',
  done: '已拍',
  reshoot: '需重拍',
};

const RESHOOT_LABEL: Record<ReshootReason, string> = {
  'no-best': '有可用条，但未选定最佳条',
  'best-ng': '最佳条被标记为不可用',
  'all-ng': '所有拍摄条均不可用',
};

const FRAMING_OPTIONS = ['大远景', '远景', '全景', '中景', '近景', '特写', '大特写'];
const CAMERA_OPTIONS = ['A 机 · 固定', 'B 机 · 固定', '手持', '轨道', '摇臂', '无人机', '斯坦尼康'];

/** 镜头编号自然序键：数字段零填充（如 2 < 10、2A < 2B），与服务端排序一致 */
function naturalShotKey(no: string): string {
  return no.replace(/\d+/g, (m) => m.padStart(12, '0'));
}

/**
 * 镜头清单：每个场景维护镜头（编号/景别/机位/必拍/备注/前置镜头）与多次拍摄结果（条）。
 * 镜头状态、场景完成度与可拍队列由服务端现算；保存后经 run() 整体刷新，即时反映。
 */
export function ShotListPanel({ shotList, run }: Props) {
  const [filterScene, setFilterScene] = useState(0);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [onlyFilmable, setOnlyFilmable] = useState(false);

  if (!shotList) return <p className="muted">暂无数据</p>;

  const t = shotList.totals;
  const scenes = shotList.scenes
    .filter((s) => filterScene === 0 || s.sceneId === filterScene)
    .filter((s) => !onlyIncomplete || !s.complete)
    // 「只看可拍」：只保留仍有镜头可拍（下一批队列非空）的场景
    .filter((s) => !onlyFilmable || s.readyQueue.length > 0);

  return (
    <div>
      <section className="card">
        <h3>镜头清单 · 前置镜头与可拍队列</h3>
        <div className="form-row">
          <label className="inline-field">
            按场景筛选
            <select value={filterScene} onChange={(e) => setFilterScene(Number(e.target.value))}>
              <option value={0}>全部场景</option>
              {shotList.scenes.map((s) => (
                <option key={s.sceneId} value={s.sceneId}>
                  #{s.storyIndex} {s.title}（{s.storyTime}）
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={onlyIncomplete}
              onChange={(e) => setOnlyIncomplete(e.target.checked)}
            />
            只看未完成场景
          </label>
          <label className="checkbox" title="只显示前置已全部就绪、现在就能拍的镜头">
            <input
              type="checkbox"
              checked={onlyFilmable}
              onChange={(e) => setOnlyFilmable(e.target.checked)}
            />
            只看可拍
          </label>
        </div>
        <p className="muted small">
          编辑镜头时可选择<b>同场景的多个前置镜头</b>（服务端拒绝自依赖与任意深度环，并返回可按镜头编号定位的闭环路径）。
          只有<b>全部前置镜头都有可用最佳条</b>时镜头才显示「▶ 可拍」，否则逐项列出阻塞原因；
          每个场景顶部的<b>下一批可拍</b>按「必拍优先、镜头编号自然序」生成。最佳条或拍摄结果变化后队列即时重算。
        </p>
      </section>

      <div className="panel-bar">
        <span className={`badge ${t.completeScenes === t.scenes && t.scenes > 0 ? 'badge-ok' : 'badge-warn'}`}>
          完成场景 {t.completeScenes}/{t.scenes}
        </span>
        <span className="badge badge-ok">已拍镜头 {t.doneShots}/{t.shots}</span>
        <span className={`badge ${t.readyShots ? 'badge-ok' : 'badge-warn'}`}>
          ▶ 现在可拍 {t.readyShots}
        </span>
        <span className={`badge ${t.pendingShots ? 'badge-warn' : 'badge-ok'}`}>
          待拍 {t.pendingShots}
        </span>
        <span className={`badge ${t.reshootShots ? 'badge-danger' : 'badge-ok'}`}>
          需重拍 {t.reshootShots}
        </span>
        {t.scenesWithoutShots > 0 && (
          <span className="badge badge-danger">缺镜头场景 {t.scenesWithoutShots}</span>
        )}
        <span className="muted small">
          必拍进度 {t.requiredDone}/{t.requiredShots}
        </span>
      </div>

      {scenes.length === 0 && (
        <p className="muted">
          {shotList.scenes.length === 0
            ? '还没有场景，请先在「场景管理」中创建。'
            : '没有符合筛选条件的场景。'}
        </p>
      )}
      {scenes.map((s) => (
        <SceneShotCard key={s.sceneId} scene={s} run={run} onlyFilmable={onlyFilmable} />
      ))}

      <datalist id="framing-options">
        {FRAMING_OPTIONS.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <datalist id="camera-options">
        {CAMERA_OPTIONS.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

/* --------------------------------- 场景卡片 --------------------------------- */

function SceneShotCard({
  scene,
  run,
  onlyFilmable,
}: {
  scene: SceneShots;
  run: Props['run'];
  onlyFilmable: boolean;
}) {
  const [draft, setDraft] = useState({ shotNo: '', framing: '', camera: '', required: true, note: '' });

  const cls = scene.complete
    ? 'shot-scene-complete'
    : scene.reshootShots > 0 || scene.totalShots === 0
      ? 'shot-scene-reshoot'
      : 'shot-scene-pending';

  const addShot = () =>
    run(async () => {
      await api.createShot(scene.sceneId, draft);
      setDraft({ shotNo: '', framing: '', camera: '', required: true, note: '' });
    });

  const pct = Math.round(scene.completion * 100);

  // 「只看可拍」模式下隐藏尚不可拍（或已完成）的镜头
  const visibleShots = onlyFilmable
    ? scene.shots.filter((s) => s.filmable && s.status !== 'done')
    : scene.shots;

  return (
    <section className={`card shot-scene ${cls}`}>
      <div className="shot-scene-head">
        <span className="time-chip">
          {scene.storyTime}
          <em>同刻 #{scene.seq}</em>
        </span>
        <h3>{scene.title}</h3>
        <span className="muted small">故事 #{scene.storyIndex}</span>
        {scene.complete ? (
          <span className="badge badge-ok">✅ 场景完成</span>
        ) : scene.totalShots === 0 ? (
          <span className="badge badge-danger">⚠ 缺镜头：尚未建立任何镜头</span>
        ) : (
          <>
            <span className="badge badge-warn">必拍 {scene.requiredDone}/{scene.requiredShots}</span>
            <span className="badge badge-ok">▶ 可拍 {scene.readyShots}</span>
            {scene.pendingShots > 0 && (
              <span className="badge badge-warn">待拍 {scene.pendingShots}</span>
            )}
            {scene.reshootShots > 0 && (
              <span className="badge badge-danger">🔁 需重拍 {scene.reshootShots}</span>
            )}
          </>
        )}
        <span className="spacer" />
        <span className="muted small">
          {scene.totalShots === 0 ? '无镜头' : `完成度 ${pct}%（${scene.doneShots}/${scene.totalShots} 镜头）`}
        </span>
      </div>

      {scene.totalShots > 0 && (
        <div className="shot-progress" title={`完成度 ${pct}%`}>
          <div
            className={`shot-progress-fill ${scene.complete ? 'shot-progress-done' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {scene.readyQueue.length > 0 && !scene.complete && (
        <div className="ready-queue">
          <span className="ready-queue-label">
            🎬 下一批可拍
            <em>必拍优先 · 编号自然序</em>
          </span>
          {scene.readyQueue.map((q) => (
            <a
              key={q.id}
              className={`ready-chip ${q.required ? 'ready-chip-req' : ''}`}
              href={`#shot-${q.id}`}
              title={`镜头 ${q.shotNo}${q.required ? '（必拍）' : '（非必拍）'}：前置已全部就绪，点击定位`}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(`shot-${q.id}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
            >
              {q.required ? '★ ' : ''}镜头 {q.shotNo}
              {q.status === 'reshoot' ? ' · 重拍' : ''}
            </a>
          ))}
        </div>
      )}

      {visibleShots.map((shot) => (
        <ShotRow key={shot.id} shot={shot} siblings={scene.shots} run={run} />
      ))}

      <div className="form-row shot-add-form">
        <input
          placeholder="镜头编号，如 1、2A"
          style={{ maxWidth: 130 }}
          value={draft.shotNo}
          onChange={(e) => setDraft({ ...draft, shotNo: e.target.value })}
        />
        <input
          placeholder="景别，如 全景"
          list="framing-options"
          style={{ maxWidth: 120 }}
          value={draft.framing}
          onChange={(e) => setDraft({ ...draft, framing: e.target.value })}
        />
        <input
          placeholder="机位，如 A 机 · 固定"
          list="camera-options"
          style={{ maxWidth: 150 }}
          value={draft.camera}
          onChange={(e) => setDraft({ ...draft, camera: e.target.value })}
        />
        <label className="checkbox" title="必拍镜头：全部完成时场景才标记完成">
          <input
            type="checkbox"
            checked={draft.required}
            onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
          />
          必拍
        </label>
        <input
          placeholder="备注（可选）"
          value={draft.note}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
        <button className="primary" onClick={addShot} disabled={!draft.shotNo.trim()}>
          ＋ 添加镜头
        </button>
      </div>
      {onlyFilmable && visibleShots.length === 0 && (
        <p className="muted small">本场景当前没有可拍镜头（前置均未就绪或已全部完成）。</p>
      )}
    </section>
  );
}

/* --------------------------------- 镜头行 --------------------------------- */

function ShotRow({
  shot,
  siblings,
  run,
}: {
  shot: ShotItem;
  siblings: ShotItem[];
  run: Props['run'];
}) {
  const [draft, setDraft] = useState({
    shotNo: shot.shotNo,
    framing: shot.framing,
    camera: shot.camera,
    required: shot.required,
    note: shot.note,
  });
  const [prereqIds, setPrereqIds] = useState<number[]>(shot.prerequisiteShotIds);
  const [showPrereqs, setShowPrereqs] = useState(false);

  useEffect(() => {
    setDraft({
      shotNo: shot.shotNo,
      framing: shot.framing,
      camera: shot.camera,
      required: shot.required,
      note: shot.note,
    });
    setPrereqIds(shot.prerequisiteShotIds);
  }, [shot]);

  const sameSet = (a: number[], b: number[]) => {
    const sa = new Set(a);
    const sb = new Set(b);
    return sa.size === sb.size && [...sa].every((v) => sb.has(v));
  };

  const fieldsDirty =
    draft.shotNo !== shot.shotNo ||
    draft.framing !== shot.framing ||
    draft.camera !== shot.camera ||
    draft.required !== shot.required ||
    draft.note !== shot.note;
  const prereqsDirty = !sameSet(prereqIds, shot.prerequisiteShotIds);

  const save = () => run(() => api.updateShot(shot.id, { ...draft, prerequisiteShotIds: prereqIds }));
  const remove = () => {
    if (window.confirm(`删除镜头「${shot.shotNo}」？其全部拍摄条与前置/被依赖关系将一并清理。`)) {
      void run(() => api.deleteShot(shot.id));
    }
  };

  const bestTake = shot.takes.find((tk) => tk.id === shot.bestTakeId);

  const togglePrereq = (id: number) =>
    setPrereqIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // 候选前置：同场景、除自己之外的镜头（按编号自然序展示）
  const candidates = siblings
    .filter((s) => s.id !== shot.id)
    .map((s) => ({ s, key: naturalShotKey(s.shotNo) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.s.id - b.s.id))
    .map((x) => x.s);
  const prereqShots = shot.prerequisiteShotIds
    .map((id) => siblings.find((s) => s.id === id))
    .filter((s): s is ShotItem => Boolean(s));

  return (
    <div id={`shot-${shot.id}`} className={`shot-row shot-${shot.status} ${shot.filmable ? 'shot-filmable' : 'shot-blocked'}`}>
      <div className="shot-row-main">
        <div className="form-row">
          <input
            className="shot-no-input"
            title="镜头编号"
            value={draft.shotNo}
            onChange={(e) => setDraft({ ...draft, shotNo: e.target.value })}
          />
          <input
            placeholder="景别"
            list="framing-options"
            style={{ maxWidth: 110 }}
            value={draft.framing}
            onChange={(e) => setDraft({ ...draft, framing: e.target.value })}
          />
          <input
            placeholder="机位"
            list="camera-options"
            style={{ maxWidth: 140 }}
            value={draft.camera}
            onChange={(e) => setDraft({ ...draft, camera: e.target.value })}
          />
          <label className="checkbox" title="必拍镜头：全部完成时场景才标记完成">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
            />
            必拍
          </label>
          <input
            placeholder="备注（可选）"
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
          <span
            className={`badge ${
              shot.status === 'done'
                ? 'badge-ok'
                : shot.status === 'reshoot'
                  ? 'badge-danger'
                  : 'badge-warn'
            }`}
            title={shot.reshootReason ? RESHOOT_LABEL[shot.reshootReason] : undefined}
          >
            {STATUS_LABEL[shot.status]}
            {shot.status === 'done' && bestTake ? ` · 最佳第 ${bestTake.takeNo} 条` : ''}
          </span>
          {shot.status !== 'done' &&
            (shot.filmable ? (
              <span className="badge badge-ok" title="全部前置镜头都已有可用最佳条，现在可以拍">
                ▶ 可拍
              </span>
            ) : (
              <span className="badge badge-warn" title="前置镜头尚未全部就绪">
                ⛔ 被前置阻塞
              </span>
            ))}
          {shot.status === 'reshoot' && shot.reshootReason && (
            <span className="bad small">{RESHOOT_LABEL[shot.reshootReason]}</span>
          )}
          {!shot.required && <span className="muted small">（非必拍）</span>}
          <span className="spacer" />
          <button
            className={`ghost ${showPrereqs ? 'take-star-on' : ''}`}
            onClick={() => setShowPrereqs((v) => !v)}
            title="选择同场景内必须先拍完（有可用最佳条）的镜头"
          >
            🔗 前置 {shot.prerequisiteShotIds.length > 0 ? `(${shot.prerequisiteShotIds.length})` : ''}
          </button>
          <button
            className="primary"
            onClick={save}
            disabled={(!fieldsDirty && !prereqsDirty) || !draft.shotNo.trim()}
            title={prereqsDirty && !fieldsDirty ? '保存前置镜头设置' : undefined}
          >
            保存
          </button>
          <button className="danger" onClick={remove}>
            删除
          </button>
        </div>

        {/* 当前已保存的前置概览 + 逐项阻塞原因 */}
        {prereqShots.length > 0 && (
          <div className="prereq-summary">
            <span className="muted small">前置：</span>
            {prereqShots.map((p) => {
              const blocker = shot.blockers.find((b) => b.prereqShotId === p.id);
              return (
                <span
                  key={p.id}
                  className={`prereq-tag ${p.status === 'done' ? 'prereq-tag-done' : 'prereq-tag-pending'}`}
                  title={blocker ? blocker.message : `镜头 ${p.shotNo} 已有可用最佳条`}
                >
                  {p.status === 'done' ? '✅' : '⏳'} 镜头 {p.shotNo}
                </span>
              );
            })}
          </div>
        )}
        {!shot.filmable && shot.blockers.length > 0 && (
          <ul className="blocker-list">
            {shot.blockers.map((b) => (
              <li key={b.prereqShotId}>
                ⛔ {b.message}
                {b.blockedByChain && <em className="muted small">（该前置自身的前置也未就绪）</em>}
              </li>
            ))}
          </ul>
        )}

        {/* 同场景前置多选；保存时统一提交，服务端检测自依赖/环并原子拒绝 */}
        {showPrereqs && (
          <div className="prereq-editor">
            <div className="muted small">
              选择必须先拍完的<b>同场景</b>镜头（可多选）。不能选择自身；形成任意深度闭环时服务端会拒绝并给出闭环路径。
            </div>
            {candidates.length === 0 && <p className="muted small">同场景还没有其他镜头。</p>}
            <div className="prereq-options">
              {candidates.map((c) => (
                <label key={c.id} className="checkbox prereq-option">
                  <input
                    type="checkbox"
                    checked={prereqIds.includes(c.id)}
                    onChange={() => togglePrereq(c.id)}
                  />
                  镜头 {c.shotNo}
                  <span className={`badge ${c.status === 'done' ? 'badge-ok' : c.status === 'reshoot' ? 'badge-danger' : 'badge-warn'}`}>
                    {STATUS_LABEL[c.status]}
                  </span>
                  {c.required && <span className="muted small">必拍</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="take-list">
          {shot.takes.map((tk) => (
            <TakeRow key={tk.id} take={tk} shotId={shot.id} run={run} />
          ))}
          {shot.takes.length === 0 && (
            <span className="muted small">尚未登记拍摄条。</span>
          )}
          <button
            className="ghost"
            onClick={() => run(() => api.addTake(shot.id, true, ''))}
            title="登记一次拍摄结果（条号自动递增）"
          >
            ＋ 登记第 {shot.takes.length + 1} 条
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- 拍摄条 --------------------------------- */

function TakeRow({
  take,
  shotId,
  run,
}: {
  take: TakeItem;
  shotId: number;
  run: Props['run'];
}) {
  const [note, setNote] = useState(take.note);

  useEffect(() => {
    setNote(take.note);
  }, [take]);

  const saveNoteIfChanged = () => {
    if (note !== take.note) void run(() => api.updateTake(take.id, take.usable, note));
  };

  return (
    <div className={`take-row ${take.isBest ? 'take-best' : ''} ${take.usable ? '' : 'take-ng'}`}>
      <span className="take-no">第 {take.takeNo} 条</span>
      <select
        value={take.usable ? '1' : '0'}
        onChange={(e) => run(() => api.updateTake(take.id, e.target.value === '1', note))}
        title="本条是否可用"
      >
        <option value="1">可用</option>
        <option value="0">NG</option>
      </select>
      <button
        className={`ghost take-star ${take.isBest ? 'take-star-on' : ''}`}
        title={take.isBest ? '取消最佳条' : '选为最佳条（每个镜头至多一条）'}
        onClick={() => run(() => api.setBestTake(shotId, take.isBest ? 0 : take.id))}
      >
        {take.isBest ? '★ 最佳条' : '☆ 设为最佳'}
      </button>
      <input
        placeholder="本条备注（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={saveNoteIfChanged}
      />
      <button
        className="ghost"
        title="删除该条"
        onClick={() => run(() => api.deleteTake(take.id))}
      >
        ✕
      </button>
    </div>
  );
}
