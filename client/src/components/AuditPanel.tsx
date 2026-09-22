import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AuditChangeType,
  type AuditReason,
  type AuditVersion,
  type AuditVersionDetail,
} from '../api';

interface Props {
  /** 版本列表在外层刷新（如排程保存后）时随之刷新 */
  refreshKey: number;
}

const CHANGE_TYPE_LABEL: Record<AuditChangeType, string> = {
  added: '新增',
  removed: '移除',
  'date-moved': '日期移动',
  'order-moved': '顺序移动',
  'lock-changed': '锁定变更',
  adjusted: '参数调整',
};

const CHANGE_TYPE_BADGE: Record<AuditChangeType, string> = {
  added: 'badge-ok',
  removed: 'badge-danger',
  'date-moved': 'badge-warn',
  'order-moved': 'badge-warn',
  'lock-changed': 'badge-warn',
  adjusted: 'badge-ok',
};

const REASON_LABEL: Record<AuditReason, string> = {
  lock: '锁定',
  capacity: '容量',
  'story-order': '故事前置',
  location: '地点调整',
  scene: '场景增删',
  other: '其他',
};

const TRIGGER_LABEL: Record<AuditVersion['triggerKind'], string> = {
  init: '初始版本',
  settings: '保存排程设置',
  lock: '锁定场次',
  unlock: '解锁场次',
};

const fmtTime = (iso: string) => iso.replace('T', ' ').slice(0, 19);

/** 排程变更审计：按版本查看变更摘要与场次详情，可将任一版本标记为基线后继续比较 */
export function AuditPanel({ refreshKey }: Props) {
  const [versions, setVersions] = useState<AuditVersion[]>([]);
  const [baselineId, setBaselineId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AuditVersionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(async (keepSelection = true) => {
    const data = await api.scheduleAudit();
    setVersions(data.versions);
    setBaselineId(data.baselineVersionId);
    setSelectedId((cur) => {
      if (keepSelection && cur && data.versions.some((v) => v.id === cur)) return cur;
      return data.versions[0]?.id ?? null;
    });
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    const d = await api.scheduleAuditVersion(id);
    setDetail(d);
  }, []);

  const reload = useCallback(async () => {
    try {
      await loadList();
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadList]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [selectedId, loadDetail, refreshKey]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <p className="muted">加载中…</p>;

  const baseline = versions.find((v) => v.id === baselineId) ?? null;

  return (
    <div>
      <section className="card">
        <h3>排程变更审计</h3>
        <p className="muted small">
          每次在「现场拍摄排程」保存拍摄日期/单日时长、锁定或解锁场次并重算后，服务端会把本次排程结果与
          {baseline ? `基线版本 V${baseline.versionNo}` : '上一版本'}
          按场景逐项比对，记录新增、移除、日期移动、顺序移动及其原因（锁定 / 容量 / 故事前置等）。
          相同输入重复保存不会产生空版本。可将任一版本标记为基线，后续版本改为与基线比较。
        </p>
        <div className="form-row">
          <span className={`badge ${baseline ? 'badge-warn' : 'badge-ok'}`}>
            {baseline ? `基线：V${baseline.versionNo}` : '未设基线（与上一版比较）'}
          </span>
          {baseline && (
            <button className="ghost" onClick={() => run(() => api.setAuditBaseline(null))}>
              清除基线
            </button>
          )}
          <span className="spacer" />
          <span className="muted small">共 {versions.length} 个版本</span>
        </div>
      </section>

      {error && (
        <div className="error-bar" onClick={() => setError('')}>
          ⚠ {error}（点击关闭）
        </div>
      )}

      {versions.length === 0 ? (
        <section className="card">
          <p className="muted empty-ok">
            还没有排程版本。到「现场拍摄排程」保存设置或锁定/解锁场次后，这里会记录第一个版本。
          </p>
        </section>
      ) : (
        <div className="audit-layout">
          <section className="card audit-versions">
            <h3>版本列表</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>时间</th>
                  <th>触发</th>
                  <th>变更</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr
                    key={v.id}
                    className={`audit-version-row ${v.id === selectedId ? 'audit-version-active' : ''}`}
                    onClick={() => setSelectedId(v.id)}
                  >
                    <td>
                      <b>V{v.versionNo}</b>
                      {v.isBaseline && (
                        <span className="badge badge-warn audit-baseline-tag">基线</span>
                      )}
                    </td>
                    <td className="muted small">{fmtTime(v.createdAt)}</td>
                    <td>
                      <span className="badge badge-ok">{TRIGGER_LABEL[v.triggerKind]}</span>
                    </td>
                    <td>
                      {v.changeCount > 0 ? (
                        <span className="badge badge-warn">{v.changeCount} 项</span>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td>
                      {v.isBaseline ? (
                        <button
                          className="ghost small-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void run(() => api.setAuditBaseline(null));
                          }}
                        >
                          取消基线
                        </button>
                      ) : (
                        <button
                          className="ghost small-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void run(() => api.setAuditBaseline(v.id));
                          }}
                        >
                          设为基线
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card audit-detail">
            {detail ? (
              <VersionDetail
                detail={detail}
                onJumpToBase={(id) => setSelectedId(id)}
              />
            ) : (
              <p className="muted">选择左侧版本查看详情</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function VersionDetail({
  detail,
  onJumpToBase,
}: {
  detail: AuditVersionDetail;
  onJumpToBase: (id: number) => void;
}) {
  const typeEntries = (
    Object.entries(detail.summary.byType) as [AuditChangeType, number][]
  ).filter(([, n]) => n > 0);
  const reasonEntries = (
    Object.entries(detail.summary.byReason) as [AuditReason, number][]
  ).filter(([, n]) => n > 0);

  // 场次详情按拍摄日 + 当日位置排序（未安排拍摄日的兜底桶排最后）
  const snaps = [...detail.snapshot.scenes].sort(
    (a, b) => a.dayIndex - b.dayIndex || a.ordinal - b.ordinal || a.sceneId - b.sceneId
  );
  const changedSceneIds = new Set(detail.changes.map((c) => c.sceneId));

  return (
    <div>
      <div className="audit-detail-head">
        <h3>
          版本 V{detail.versionNo}
          {detail.isBaseline && <span className="badge badge-warn audit-baseline-tag">基线</span>}
        </h3>
        <span className="spacer" />
        <span className="muted small">{fmtTime(detail.createdAt)}</span>
      </div>

      <div className="audit-meta">
        <span className="badge badge-ok">{TRIGGER_LABEL[detail.triggerKind]}</span>
        <span className="muted small">{detail.triggerNote}</span>
      </div>
      <div className="audit-meta">
        <span className="muted small">对比基准：</span>
        {detail.baseVersionId ? (
          <button className="ghost small-btn" onClick={() => onJumpToBase(detail.baseVersionId!)}>
            V{detail.baseVersionNo}
            {detail.baseIsBaseline ? '（基线）' : '（上一版）'} →
          </button>
        ) : (
          <span className="muted small">无（首个版本，作为后续比较起点）</span>
        )}
      </div>

      <h4>变更摘要</h4>
      {detail.changeCount === 0 ? (
        <p className="muted small">本版无逐项变更（初始版本或仅记录快照）。</p>
      ) : (
        <>
          <div className="form-row">
            {typeEntries.map(([t, n]) => (
              <span key={t} className={`badge ${CHANGE_TYPE_BADGE[t]}`}>
                {CHANGE_TYPE_LABEL[t]} {n}
              </span>
            ))}
          </div>
          <div className="form-row">
            <span className="muted small">原因分布：</span>
            {reasonEntries.map(([r, n]) => (
              <span key={r} className="badge badge-warn">
                {REASON_LABEL[r]} {n}
              </span>
            ))}
          </div>
        </>
      )}

      {detail.changes.length > 0 && (
        <>
          <h4>变更明细（{detail.changes.length}）</h4>
          <ul className="conflict-list">
            {detail.changes.map((c) => (
              <li key={c.id}>
                <span className={`badge ${CHANGE_TYPE_BADGE[c.changeType]}`}>
                  {CHANGE_TYPE_LABEL[c.changeType]}
                </span>
                <span>
                  <b>{c.sceneTitle}</b>
                  <span className="muted small">（故事 #{c.storyIndex}）</span>{' '}
                  {c.reasons.map((r) => (
                    <span key={r} className="badge badge-warn audit-reason-tag">
                      {REASON_LABEL[r]}
                    </span>
                  ))}{' '}
                  <span className="muted small">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>场次详情（本版快照 · {snaps.length} 场）</h4>
      {snaps.length === 0 ? (
        <p className="muted small">本版没有任何场次。</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>拍摄日</th>
              <th>位置</th>
              <th>场景</th>
              <th>地点</th>
              <th>分钟</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {snaps.map((s) => (
              <tr
                key={s.sceneId}
                className={changedSceneIds.has(s.sceneId) ? 'row-first' : ''}
                title={changedSceneIds.has(s.sceneId) ? '本场在本版有变更' : ''}
              >
                <td>{s.date || '（未安排拍摄日）'}</td>
                <td>#{s.ordinal}</td>
                <td>
                  {s.locked && <span title="已锁定">🔒</span>}
                  {s.title}
                  <span className="muted small">（故事 #{s.storyIndex}）</span>
                </td>
                <td className="muted small">{s.location || '（未填写地点）'}</td>
                <td className="muted small">
                  {s.startMinute}–{s.endMinute}
                </td>
                <td>
                  {s.overflow && <span className="badge badge-danger">超时</span>}
                  {s.orderViolation && <span className="badge badge-danger">违反顺序</span>}
                  {!s.overflow && !s.orderViolation && <span className="muted small">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        本版设置：{detail.snapshot.settings.dates.length} 个拍摄日（
        {detail.snapshot.settings.dates.join('、') || '无'}），单日预计{' '}
        {detail.snapshot.settings.dayMinutes} 分钟。高亮行为本版发生变更的场次。
      </p>
    </div>
  );
}
