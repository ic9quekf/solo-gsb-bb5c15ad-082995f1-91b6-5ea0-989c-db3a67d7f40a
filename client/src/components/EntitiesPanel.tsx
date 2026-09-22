import { useState } from 'react';
import { api, type Entity } from '../api';

interface Props {
  entities: Entity[];
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

interface FieldDraft {
  id?: number;
  key: string;
  label: string;
  initialValue: string;
}

const emptyDraft = { name: '', kind: 'character', description: '', fields: [] as FieldDraft[] };

/** 对象（角色/道具）与其状态字段的维护 */
export function EntitiesPanel({ entities, run }: Props) {
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState<number | null>(null);

  const startEdit = (e: Entity) => {
    setEditingId(e.id);
    setDraft({
      name: e.name,
      kind: e.kind,
      description: e.description,
      fields: e.fields.map((f) => ({
        id: f.id,
        key: f.key,
        label: f.label,
        initialValue: f.initialValue,
      })),
    });
  };

  const reset = () => {
    setEditingId(null);
    setDraft(emptyDraft);
  };

  const save = () =>
    run(async () => {
      if (editingId) {
        await api.updateEntity(editingId, draft);
      } else {
        await api.createEntity(draft);
      }
      reset();
    });

  const setField = (i: number, patch: Partial<FieldDraft>) =>
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)),
    }));

  return (
    <div className="entities-layout">
      <section className="card">
        <h3>{editingId ? `编辑对象 #${editingId}` : '新建对象（角色 / 道具）'}</h3>
        <div className="form-row">
          <input
            placeholder="名称，如：林雪 / 旧怀表"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
          >
            <option value="character">角色</option>
            <option value="prop">道具</option>
          </select>
          <input
            placeholder="描述（可选）"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>

        <h4>状态字段（key / 显示名 / 初始值）</h4>
        {draft.fields.map((f, i) => (
          <div key={i} className="form-row">
            <input
              placeholder="key，如 costume"
              value={f.key}
              onChange={(e) => setField(i, { key: e.target.value })}
            />
            <input
              placeholder="显示名，如 服装"
              value={f.label}
              onChange={(e) => setField(i, { label: e.target.value })}
            />
            <input
              placeholder="初始值，如 蓝色风衣"
              value={f.initialValue}
              onChange={(e) => setField(i, { initialValue: e.target.value })}
            />
            <button
              className="ghost"
              onClick={() =>
                setDraft((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))
              }
            >
              ✕
            </button>
          </div>
        ))}
        <div className="form-row">
          <button
            className="ghost"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                fields: [...d.fields, { key: '', label: '', initialValue: '' }],
              }))
            }
          >
            ＋ 添加字段
          </button>
          <button className="primary" onClick={save} disabled={!draft.name}>
            {editingId ? '保存修改' : '＋ 创建对象'}
          </button>
          {editingId !== null && (
            <button className="ghost" onClick={reset}>
              取消编辑
            </button>
          )}
        </div>
        <p className="muted small">
          注意：删除字段会同时清理引用它的快照与变更；修改 key 会自动迁移历史数据。
        </p>
      </section>

      <section className="card">
        <h3>已有对象（{entities.length}）</h3>
        {entities.length === 0 && <p className="muted">还没有对象。</p>}
        {entities.map((e) => (
          <div key={e.id} className="entity-item">
            <div className="entity-head">
              <span className="entity-name">
                {e.kind === 'character' ? '👤' : '📦'} {e.name}
              </span>
              <span className="muted small">{e.description}</span>
              <span className="spacer" />
              <button className="ghost" onClick={() => startEdit(e)}>
                编辑
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (window.confirm(`删除对象「${e.name}」？相关快照与变更将一并删除。`)) {
                    void run(() => api.deleteEntity(e.id));
                  }
                }}
              >
                删除
              </button>
            </div>
            <div className="field-chips">
              {e.fields.map((f) => (
                <span key={f.id} className="field-chip" title={`key: ${f.key}`}>
                  {f.label} = <b>{f.initialValue || '∅'}</b>
                </span>
              ))}
              {e.fields.length === 0 && <span className="muted small">（无字段）</span>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
