import type { ContinuityReport } from '../api';

interface Props {
  report: ContinuityReport | null;
  filterEntity: number;
}

/** 按故事时间顺序展示每个场景：开拍前逐字段比对结果 + 结束后应用的显式变更 */
export function TimelinePanel({ report, filterEntity }: Props) {
  if (!report) return <p className="muted">暂无数据</p>;
  if (report.timeline.length === 0) {
    return <p className="muted">还没有场景，请先到「场景管理」创建。</p>;
  }

  return (
    <div className="timeline">
      {report.timeline.map((item, idx) => {
        const checks = filterEntity
          ? item.checks.filter((c) => c.entityId === filterEntity)
          : item.checks;
        const changes = filterEntity
          ? item.changes.filter((c) => c.entityId === filterEntity)
          : item.changes;
        const conflictCount = checks.filter((c) => !c.match).length;

        return (
          <div key={item.scene.id} className={`tl-item ${conflictCount ? 'tl-conflict' : ''}`}>
            <div className="tl-rail">
              <div className={`tl-dot ${conflictCount ? 'dot-danger' : 'dot-ok'}`} />
              {idx < report.timeline.length - 1 && <div className="tl-line" />}
            </div>
            <div className="tl-card">
              <div className="tl-head">
                <span className="time-chip">
                  {item.scene.storyTime}
                  <em>同刻 #{item.scene.seq}</em>
                </span>
                <h3>{item.scene.title}</h3>
                {conflictCount > 0 && (
                  <span className="badge badge-danger">{conflictCount} 处不一致</span>
                )}
                {item.scene.description && (
                  <span className="muted small">{item.scene.description}</span>
                )}
              </div>

              {checks.length > 0 && (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>对象</th>
                      <th>字段</th>
                      <th>期望快照</th>
                      <th>开拍前推导</th>
                      <th>结果</th>
                      <th>推导来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c, i) => (
                      <tr key={i} className={c.match ? '' : 'row-conflict'}>
                        <td>{c.entityName}</td>
                        <td>{c.fieldLabel}</td>
                        <td>{c.expected}</td>
                        <td>{c.actual}</td>
                        <td>{c.match ? <span className="ok">✓ 一致</span> : <span className="bad">✗ 分歧</span>}</td>
                        <td className="muted small">
                          {c.source.sceneId === null
                            ? '初始值'
                            : `「${c.source.sceneTitle}」的变更（${c.source.storyTime} #${c.source.seq}）`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {changes.length > 0 && (
                <div className="changes">
                  <span className="muted small">结束后变更：</span>
                  {changes.map((c, i) => (
                    <span key={i} className="change-chip" title={c.note}>
                      {c.entityName}·{c.fieldLabel}：<s>{c.before || '∅'}</s> →{' '}
                      <b>{c.value || '∅'}</b>
                      {c.note && <i>（{c.note}）</i>}
                    </span>
                  ))}
                </div>
              )}

              {checks.length === 0 && changes.length === 0 && (
                <p className="muted small">该场景在当前筛选下无快照校验与变更。</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
