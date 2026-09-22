import { useEffect, useState } from 'react';
import { api, type Entity, type Scene } from '../api';

interface Props {
  scenes: Scene[];
  entities: Entity[];
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

/** 场景管理：录入故事时间+同刻序号、期望快照、结束后的显式变更、拍摄排程信息 */
export function ScenesPanel({ scenes, entities, run }: Props) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [form, setForm] = useState({
    title: '',
    storyTime: '',
    seq: 1,
    description: '',
    location: '',
    estMinutes: 30,
    minStoryIndex: 0,
  });

  const create = () =>
    run(async () => {
      await api.createScene(form);
      setForm({ title: '', storyTime: '', seq: 1, description: '', location: '', estMinutes: 30, minStoryIndex: 0 });
    });

  return (
    <div>
      <section className="card">
        <h3>新建场景</h3>
        <div className="form-row">
          <input
            placeholder="场景标题，如：雨夜公寓"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <input
            placeholder="故事时间，如 D01 21:00"
            value={form.storyTime}
            onChange={(e) => setForm({ ...form, storyTime: e.target.value })}
          />
          <input
            type="number"
            className="seq-input"
            title="同刻序号"
            placeholder="同刻序号"
            value={form.seq}
            onChange={(e) => setForm({ ...form, seq: Number(e.target.value) })}
          />
          <input
            placeholder="拍摄地点，如 A 棚 · 公寓内景"
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
          />
          <input
            type="number"
            className="seq-input"
            title="预计拍摄分钟数"
            placeholder="预计分钟"
            value={form.estMinutes}
            onChange={(e) => setForm({ ...form, estMinutes: Number(e.target.value) })}
          />
          <input
            type="number"
            className="seq-input"
            title="不可提前的故事序号：本场只能在故事线第 1..N 场全部拍完后拍摄；0 = 无约束"
            placeholder="不可早于故事#"
            value={form.minStoryIndex}
            onChange={(e) => setForm({ ...form, minStoryIndex: Number(e.target.value) })}
          />
          <input
            placeholder="备注（可选）"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <button className="primary" onClick={create} disabled={!form.title || !form.storyTime}>
            ＋ 创建
          </button>
        </div>
        <p className="muted small">
          重放顺序 = 故事时间（字符串排序，建议 D01/D02… 这类可排序格式）→ 同刻序号，与拍摄排程相互独立。
          「拍摄地点 / 预计分钟数 / 不可早于故事#」供「现场拍摄排程」使用：序号 N 表示故事线第 1..N 场全部拍完后本场才能拍（0 = 无约束）。
        </p>
      </section>

      {scenes.map((s) => (
        <SceneEditor
          key={s.id}
          scene={s}
          entities={entities}
          open={openId === s.id}
          onToggle={() => setOpenId(openId === s.id ? null : s.id)}
          run={run}
        />
      ))}
      {scenes.length === 0 && <p className="muted">还没有场景。</p>}
    </div>
  );
}

function SceneEditor({
  scene,
  entities,
  open,
  onToggle,
  run,
}: {
  scene: Scene;
  entities: Entity[];
  open: boolean;
  onToggle: () => void;
  run: Props['run'];
}) {
  return (
    <section className="card">
      <div className="scene-head" onClick={onToggle}>
        <span className="time-chip">
          {scene.storyTime}
          <em>同刻 #{scene.seq}</em>
        </span>
        <h3>{scene.title}</h3>
        <span className="muted small">故事 #{scene.storyIndex}</span>
        {scene.location && <span className="time-chip">📍 {scene.location}</span>}
        <span className="muted small">
          {scene.estMinutes} 分钟
          {scene.minStoryIndex > 0 ? ` · 不可早于故事 #${scene.minStoryIndex}` : ''}
        </span>
        <span className="muted small">
          快照 {scene.snapshots.length} 项 · 变更 {scene.changes.length} 项
        </span>
        <span className="spacer" />
        <button className="ghost">{open ? '收起 ▲' : '编辑 ▼'}</button>
      </div>
      {open && <SceneEditorBody scene={scene} entities={entities} run={run} />}
    </section>
  );
}

function SceneEditorBody({
  scene,
  entities,
  run,
}: {
  scene: Scene;
  entities: Entity[];
  run: Props['run'];
}) {
  const [meta, setMeta] = useState({
    title: scene.title,
    storyTime: scene.storyTime,
    seq: scene.seq,
    description: scene.description,
    location: scene.location,
    estMinutes: scene.estMinutes,
    minStoryIndex: scene.minStoryIndex,
  });
  // 快照：entityId -> fieldKey -> expectedValue（空串 = 不校验）
  const [snap, setSnap] = useState<Record<number, Record<string, string>>>({});
  // 变更行
  const [rows, setRows] = useState<{ entityId: number; fieldKey: string; value: string; note: string }[]>([]);

  useEffect(() => {
    setMeta({
      title: scene.title,
      storyTime: scene.storyTime,
      seq: scene.seq,
      description: scene.description,
      location: scene.location,
      estMinutes: scene.estMinutes,
      minStoryIndex: scene.minStoryIndex,
    });
    const m: Record<number, Record<string, string>> = {};
    for (const s of scene.snapshots) {
      (m[s.entityId] ??= {})[s.fieldKey] = s.expectedValue;
    }
    setSnap(m);
    setRows(
      scene.changes.map((c) => ({
        entityId: c.entityId,
        fieldKey: c.fieldKey,
        value: c.value,
        note: c.note,
      }))
    );
  }, [scene]);

  const saveMeta = () => run(() => api.updateScene(scene.id, meta));
  const remove = () => {
    if (window.confirm(`删除场景「${scene.title}」？其快照与变更将一并删除。`)) {
      void run(() => api.deleteScene(scene.id));
    }
  };

  const saveSnap = () =>
    run(() =>
      api.saveSnapshot(
        scene.id,
        Object.entries(snap).flatMap(([entityId, fields]) =>
          Object.entries(fields)
            .filter(([, v]) => v.trim() !== '')
            .map(([fieldKey, expectedValue]) => ({
              entityId: Number(entityId),
              fieldKey,
              expectedValue,
            }))
        )
      )
    );

  const saveRows = () =>
    run(() =>
      api.saveChanges(
        scene.id,
        rows.filter((r) => r.entityId && r.fieldKey)
      )
    );

  return (
    <div className="scene-body">
      <div className="form-row">
        <input
          value={meta.title}
          onChange={(e) => setMeta({ ...meta, title: e.target.value })}
          placeholder="场景标题"
        />
        <input
          value={meta.storyTime}
          onChange={(e) => setMeta({ ...meta, storyTime: e.target.value })}
          placeholder="故事时间"
        />
        <input
          type="number"
          className="seq-input"
          title="同刻序号"
          value={meta.seq}
          onChange={(e) => setMeta({ ...meta, seq: Number(e.target.value) })}
        />
        <input
          value={meta.description}
          onChange={(e) => setMeta({ ...meta, description: e.target.value })}
          placeholder="备注（可选）"
        />
      </div>
      <div className="form-row sched-fields">
        <label className="inline-field">
          📍 拍摄地点
          <input
            value={meta.location}
            placeholder="如 A 棚 · 公寓内景"
            onChange={(e) => setMeta({ ...meta, location: e.target.value })}
          />
        </label>
        <label className="inline-field">
          ⏱ 预计分钟数
          <input
            type="number"
            min={1}
            style={{ width: 90 }}
            value={meta.estMinutes}
            onChange={(e) => setMeta({ ...meta, estMinutes: Number(e.target.value) })}
          />
        </label>
        <label className="inline-field">
          🔢 不可早于故事 #
          <input
            type="number"
            min={0}
            max={Math.max(0, scene.storyIndex - 1)}
            style={{ width: 80 }}
            title={`本场是故事 #${scene.storyIndex}；填 N（1..${Math.max(0, scene.storyIndex - 1)}）表示故事线第 1..N 场全部拍完后才能拍本场，0 = 无约束`}
            value={meta.minStoryIndex}
            onChange={(e) => setMeta({ ...meta, minStoryIndex: Number(e.target.value) })}
          />
        </label>
        <span className="muted small">
          本场为故事 #{scene.storyIndex}；序号 0 = 无顺序约束
        </span>
        <button className="primary" onClick={saveMeta}>
          保存场景
        </button>
        <button className="danger" onClick={remove}>
          删除
        </button>
      </div>

      <h4>期望快照（开拍前应有的状态；留空 = 不校验该字段）</h4>
      {entities.length === 0 && <p className="muted">请先在「对象与字段」中创建对象。</p>}
      {entities.map((e) => (
        <div key={e.id} className="snap-entity">
          <div className="snap-entity-name">
            {e.kind === 'character' ? '👤' : '📦'} {e.name}
          </div>
          <div className="snap-fields">
            {e.fields.map((f) => (
              <label key={f.id} className="snap-field">
                <span>{f.label}</span>
                <input
                  value={snap[e.id]?.[f.key] ?? ''}
                  placeholder={`初始：${f.initialValue || '∅'}`}
                  onChange={(ev) =>
                    setSnap((prev) => ({
                      ...prev,
                      [e.id]: { ...prev[e.id], [f.key]: ev.target.value },
                    }))
                  }
                />
              </label>
            ))}
            {e.fields.length === 0 && <span className="muted small">（无字段）</span>}
          </div>
        </div>
      ))}
      <button className="primary" onClick={saveSnap}>
        保存快照
      </button>

      <h4>结束后的显式状态变更</h4>
      {rows.map((r, i) => {
        const entity = entities.find((e) => e.id === r.entityId);
        return (
          <div key={i} className="form-row change-row">
            <select
              value={r.entityId}
              onChange={(e) => {
                const entityId = Number(e.target.value);
                const first = entities.find((x) => x.id === entityId)?.fields[0]?.key ?? '';
                setRows(rows.map((x, j) => (j === i ? { ...x, entityId, fieldKey: first } : x)));
              }}
            >
              <option value={0}>选择对象…</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <select
              value={r.fieldKey}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, fieldKey: e.target.value } : x)))
              }
            >
              <option value="">选择字段…</option>
              {(entity?.fields ?? []).map((f) => (
                <option key={f.id} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              placeholder="变更为（值）"
              value={r.value}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
            />
            <input
              placeholder="备注（可选）"
              value={r.note}
              onChange={(e) =>
                setRows(rows.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))
              }
            />
            <button className="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        );
      })}
      <div className="form-row">
        <button
          className="ghost"
          onClick={() =>
            setRows([...rows, { entityId: entities[0]?.id ?? 0, fieldKey: entities[0]?.fields[0]?.key ?? '', value: '', note: '' }])
          }
        >
          ＋ 添加变更
        </button>
        <button className="primary" onClick={saveRows}>
          保存变更
        </button>
      </div>
    </div>
  );
}
