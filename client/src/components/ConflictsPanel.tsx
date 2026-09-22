import { useState } from 'react';
import type { ContinuityReport } from '../api';

interface Props {
  report: ContinuityReport | null;
  filterEntity: number;
}

/** 冲突列表：所有「期望快照 ≠ 推导状态」的记录，可只看每个对象字段的首次分歧 */
export function ConflictsPanel({ report, filterEntity }: Props) {
  const [onlyFirst, setOnlyFirst] = useState(false);
  if (!report) return <p className="muted">暂无数据</p>;

  let conflicts = report.conflicts;
  if (filterEntity) conflicts = conflicts.filter((c) => c.entityId === filterEntity);
  if (onlyFirst) conflicts = conflicts.filter((c) => c.firstDivergence);

  return (
    <div>
      <div className="panel-bar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={onlyFirst}
            onChange={(e) => setOnlyFirst(e.target.checked)}
          />
          仅显示每个「对象+字段」的首次分歧
        </label>
        <span className="muted small">
          共 {conflicts.length} 条（分歧会持续影响后续场景，修复首次分歧后请重新检查）
        </span>
      </div>

      {conflicts.length === 0 ? (
        <p className="ok empty-ok">✓ 当前筛选下没有连续性冲突</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>对象</th>
              <th>字段</th>
              <th>分歧场景</th>
              <th>期望快照</th>
              <th>开拍前推导</th>
              <th>推导来源场景</th>
              <th>首次</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c, i) => (
              <tr key={i} className={c.firstDivergence ? 'row-first' : ''}>
                <td>
                  {c.entityKind === 'character' ? '👤' : '📦'} {c.entityName}
                </td>
                <td>{c.fieldLabel}</td>
                <td>
                  「{c.sceneTitle}」
                  <span className="muted small">
                    {' '}
                    {c.storyTime} #{c.seq}
                  </span>
                </td>
                <td className="bad">{c.expected}</td>
                <td>{c.actual}</td>
                <td>
                  {c.source.sceneId === null ? (
                    <span className="muted">初始值</span>
                  ) : (
                    <>
                      「{c.source.sceneTitle}」
                      <span className="muted small">
                        {' '}
                        {c.source.storyTime} #{c.source.seq}
                      </span>
                    </>
                  )}
                </td>
                <td>{c.firstDivergence ? <span className="badge badge-warn">首次分歧</span> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
