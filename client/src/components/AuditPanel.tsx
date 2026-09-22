import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AuditChange,
  type AuditChangeType,
  type AuditDetail,
  type AuditListResult,
  type AuditReasonCode,
  type AuditTrigger,
} from '../api';

interface Props {
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

const TRIGGER_LABEL: Record<AuditTrigger, string> = {
  init: '初始版本',
  settings: '保存设置',
  lock: '锁定场次',
  unlock: '解锁场次',
  manual: '手动归档',
  compare: '版本比较',
};

const CHANGE_LABEL: Record<AuditChangeType, string> = {
  added: '新增',
  removed: '移除',
  'date-moved': '日期移动',
  'order-moved': '顺序移动',
  'lock-changed': '锁定变化',
};

const CHANGE_BADGE: Record<AuditChangeType, string> = {
  added: 'badge-ok',
  removed: 'badge-danger',
  'date-moved': 'badge-warn',
  'order-moved': 'badge-warn',
  'lock-changed': 'badge-warn',
};

const REASON_LABEL: Record<AuditReasonCode, string> = {
  lock: '锁定',
  capacity: '容量',
  'story-prereq': '故事前置',
  'new-scene': '新增场景',
  'removed-scene': '移除场景',
  other: '其他',
};

const fmtPos = (date: string, ordinal: number | null) =>
  date ? `${date} 第 ${ordinal ?? '?'} 位` : '未排入拍摄日';

/** 排程变更审计：版本列表 + 逐版本变更摘要/场次详情 + 基线标记 + 任意两版比较 */
export function AuditPanel({ run }: Props) {
  const [list, setList] = useState<AuditListResult | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [compareFrom, setCompareFrom] = useState(0);
  const [compareTo, setCompareTo] = useState(0);
  const [comparing, setComparing] = useState(false);

  const reloadList = useCallback(async (keepSelection?: number | null) => {
    const r = await api.auditList();
    setList(r);
    setSelectedId((cur) => {
      const want = keepSelection !== undefined ? keepSelection : cur;
      if (want && r.versions.some((v) => v.id === want)) return want;
      return r.latestId ?? r.versions[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  // 选中版本后加载详情（比较模式下由比较按钮显式加载）
  useEffect(() => {
    if (comparing) return;
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .auditDetail(selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, comparing]);

  const refresh = () =>
    run(async () => {
      await reloadList();
    });

  const recordNow = () =>
    run(async () => {
      const r = await api.auditRecord();
      await reloadList(r.audit?.id ?? null);
    });

  const markBaseline = (id: number) =>
    run(async () => {
      await api.auditSetBaseline(id);
      await reloadList();
      if (selectedId != null && !comparing) setDetail(await api.auditDetail(selectedId));
    });

  const doCompare = () =>
    run(async () => {
      const d = await api.auditCompare(compareFrom, compareTo);
      setComparing(true);
      setDetail(d);
    });

  const exitCompare = () => {
    setComparing(false);
    setDetail(null);
  };

  if (!list) return <p className="muted">加载中…</p>;

  const baseline = list.versions.find((v) => v.id === list.baselineId) ?? null;

  return (
    <div>
      <div className="panel-bar">
        <span className="badge badge-ok">
          {baseline ? `基线：版本 #${baseline.id}` : '未标记基线（与上一版比较）'}
        </span>
        <span className="badge">共 {list.versions.length} 个版本</span>
        {list.drift && (
          <span className="badge badge-warn" title="场景增删、地点/时长/故事前置等编辑会改变排程输入">
            当前排程有未归档改动
          </span>
        )}
        <span className="spacer" />
        <button className="ghost" onClick={refresh}>
          ↻ 刷新
        </button>
        <button
          className="primary"
          title="把当前排程结果记录为一个审计版本（与基线比较；零变更时不会产生空版本）"
          onClick={recordNow}
        >
          ＋ 归档当前排程为版本
        </button>
      </div>

      <p className="muted small">
        每次在「现场拍摄排程」保存拍摄日期 / 单日容量 / 场次锁定并重算后，服务端会将结果与基线版本逐项比对并落库；
        同一输入重复保存或比对零变更时不会产生空版本。点击任一版本可将其标记为基线，之后的新版本继续与该基线比较。
      </p>

      {list.versions.length === 0 ? (
        <p className="muted empty-ok">暂无审计版本：保存排程设置或锁定场次后将自动生成。</p>
      ) : (
        <div className="audit-layout">
          {/* ---------------- 版本列表 ---------------- */}
          <div className="audit-versions">
            {list.versions.map((v) => (
              <div
                key={v.id}
                className={`audit-version ${selectedId === v.id && !comparing ? 'audit-version-active' : ''}`}
                onClick={() => {
                  setComparing(false);
                  setSelectedId(v.id);
                }}
              >
                <div className="audit-version-head">
                  <b>#{v.id}</b>
                  <span className="badge">{TRIGGER_LABEL[v.trigger]}</span>
                  {v.isBaseline && <span className="badge badge-ok">基线</span>}
                  {list.latestId === v.id && <span className="badge">最新</span>}
                  <span className="spacer" />
                  <span className={`badge ${v.changeCount ? 'badge-warn' : 'badge-ok'}`}>
                    变更 {v.changeCount}
                  </span>
                </div>
                <div className="muted small">{v.createdAt}</div>
                <div className="muted small audit-version-note">{v.note}</div>
                <div className="audit-version-actions">
                  {!v.isBaseline && (
                    <button
                      className="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        void markBaseline(v.id);
                      }}
                    >
                      ★ 设为基线
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ---------------- 版本详情 / 比较 ---------------- */}
          <div className="audit-detail">
            <section className="card">
              <h3>任意两版比较</h3>
              <div className="form-row">
                <label className="inline-field">
                  从
                  <select
                    value={compareFrom}
                    onChange={(e) => setCompareFrom(Number(e.target.value))}
                  >
                    <option value={0}>选择版本</option>
                    {list.versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        #{v.id}（{TRIGGER_LABEL[v.trigger]} · {v.createdAt}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-field">
                  到
                  <select value={compareTo} onChange={(e) => setCompareTo(Number(e.target.value))}>
                    <option value={0}>选择版本</option>
                    {list.versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        #{v.id}（{TRIGGER_LABEL[v.trigger]} · {v.createdAt}）
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={!compareFrom || !compareTo || compareFrom === compareTo}
                  onClick={doCompare}
                >
                  比较
                </button>
                {comparing && (
                  <button className="ghost" onClick={exitCompare}>
                    退出比较
                  </button>
                )}
              </div>
            </section>

            {detail ? (
              <AuditDetailView
                detail={detail}
                showUnchanged={showUnchanged}
                onToggleUnchanged={() => setShowUnchanged((s) => !s)}
              />
            ) : (
              <p className="muted">在左侧选择版本查看变更详情，或在上方选择两个版本进行比较。</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AuditDetailView({
  detail,
  showUnchanged,
  onToggleUnchanged,
}: {
  detail: AuditDetail;
  showUnchanged: boolean;
  onToggleUnchanged: () => void;
}) {
  const { summary } = detail;
  const total =
    summary.added + summary.removed + summary.dateMoved + summary.orderMoved + summary.lockChanged;

  return (
    <section className="card">
      <div className="audit-detail-head">
        <h3>
          {detail.compareMode ? '版本比较' : '版本详情'}：
          {detail.baseVersion ? ` #${detail.baseVersion.id}` : ' （无基准）'} →{' '}
          {detail.targetVersion ? `#${detail.targetVersion.id}` : '？'}
        </h3>
        {detail.targetVersion && (
          <span className="muted small">
            {TRIGGER_LABEL[detail.targetVersion.trigger]} · {detail.targetVersion.createdAt} · 单日{' '}
            {detail.targetVersion.dayMinutes} 分钟
          </span>
        )}
      </div>
      {detail.targetVersion && <p className="muted small">{detail.targetVersion.note}</p>}

      <div className="panel-bar">
        <span className="badge badge-ok">新增 {summary.added}</span>
        <span className="badge badge-danger">移除 {summary.removed}</span>
        <span className="badge badge-warn">日期移动 {summary.dateMoved}</span>
        <span className="badge badge-warn">顺序移动 {summary.orderMoved}</span>
        <span className="badge badge-warn">锁定变化 {summary.lockChanged}</span>
        <span className="badge">在排场次 {detail.totalScenesBefore} → {detail.totalScenesAfter}</span>
      </div>

      {detail.dateStats.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>拍摄日</th>
              <th>基准场次数</th>
              <th>本版场次数</th>
              <th>变化</th>
            </tr>
          </thead>
          <tbody>
            {detail.dateStats.map((d) => (
              <tr key={`${d.date}-${d.dayIndex}`}>
                <td>{d.date ? `📅 ${d.date}` : '（未排入拍摄日）'}</td>
                <td>{d.beforeCount}</td>
                <td>{d.afterCount}</td>
                <td>
                  {d.afterCount === d.beforeCount ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className={d.afterCount > d.beforeCount ? 'ok' : 'bad'}>
                      {d.afterCount > d.beforeCount ? '+' : ''}
                      {d.afterCount - d.beforeCount}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {total === 0 ? (
        <p className="ok empty-ok">✓ 两版排程逐项一致，没有任何变更</p>
      ) : (
        <div className="audit-changes">
          {detail.changes.map((c, i) => (
            <ChangeRow key={c.id ?? i} change={c} />
          ))}
        </div>
      )}

      {detail.unchanged.length > 0 && (
        <div className="audit-unchanged">
          <button className="ghost" onClick={onToggleUnchanged}>
            {showUnchanged ? '▾ 收起未变更场次' : `▸ 显示未变更场次（${detail.unchanged.length}）`}
          </button>
          {showUnchanged && (
            <table className="grid">
              <thead>
                <tr>
                  <th>场景</th>
                  <th>故事序号</th>
                  <th>位置</th>
                  <th>锁定</th>
                </tr>
              </thead>
              <tbody>
                {detail.unchanged.map((u) => (
                  <tr key={u.sceneId}>
                    <td>「{u.sceneTitle}」</td>
                    <td>#{u.storyIndex}</td>
                    <td>{fmtPos(u.date, u.ordinal)}</td>
                    <td>{u.locked ? '🔒' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

function ChangeRow({ change }: { change: AuditChange }) {
  return (
    <div className={`audit-change audit-change-${change.changeType}`}>
      <div className="audit-change-head">
        <span className={`badge ${CHANGE_BADGE[change.changeType]}`}>
          {CHANGE_LABEL[change.changeType]}
        </span>
        <b>「{change.sceneTitle}」</b>
        <span className="muted small">故事 #{change.storyIndex}</span>
        <span className="spacer" />
        {change.fromLocked !== change.toLocked && (
          <span className="muted small">{change.toLocked ? '🔒 已锁定' : '🔓 已解锁'}</span>
        )}
      </div>
      <div className="audit-change-move muted small">
        {change.changeType === 'added' && <>→ {fmtPos(change.toDate, change.toOrdinal)}</>}
        {change.changeType === 'removed' && <>{fmtPos(change.fromDate, change.fromOrdinal)} → 移出排程</>}
        {(change.changeType === 'date-moved' ||
          change.changeType === 'order-moved' ||
          change.changeType === 'lock-changed') && (
          <>
            {fmtPos(change.fromDate, change.fromOrdinal)} → {fmtPos(change.toDate, change.toOrdinal)}
          </>
        )}
      </div>
      <ul className="audit-reasons">
        {change.reasons.map((r, i) => (
          <li key={i}>
            <span className="badge audit-reason-badge">{REASON_LABEL[r.code]}</span>
            <span>{r.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
