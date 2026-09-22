import { useEffect, useState } from 'react';
import {
  api,
  type ScheduleConflict,
  type ScheduleDay,
  type ScheduleReport,
} from '../api';

interface Props {
  schedule: ScheduleReport | null;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  /** 锁定/解锁/设置保存后，用服务端返回的最新排程直接更新，避免整页闪烁 */
  onSchedule: (r: ScheduleReport) => void;
}

const CONFLICT_LABEL: Record<ScheduleConflict['type'], string> = {
  'capacity-overflow': '容量冲突',
  'order-violation': '顺序冲突',
  'lock-order': '锁定冲突',
  'lock-overlap': '锁定重叠',
  'lock-invalid-date': '锁定失效',
};

/** 现场拍摄排程：按拍摄日展示确定性排程、地点切换说明、冲突原因，并可锁定/解锁场次 */
export function SchedulePanel({ schedule, run, onSchedule }: Props) {
  const [dayMinutes, setDayMinutes] = useState(480);
  const [dates, setDates] = useState<string[]>([]);
  const [newDate, setNewDate] = useState('');
  const [savedAt, setSavedAt] = useState('');

  useEffect(() => {
    if (schedule) {
      setDayMinutes(schedule.settings.dayMinutes);
      setDates(schedule.settings.dates);
    }
  }, [schedule]);

  if (!schedule) return <p className="muted">暂无数据</p>;

  const saveSettings = () =>
    run(async () => {
      const r = await api.updateScheduleSettings({ dayMinutes, dates });
      setDayMinutes(r.dayMinutes);
      setDates(r.dates);
      setSavedAt(new Date().toLocaleTimeString());
      const report = await api.schedule();
      onSchedule(report);
    });

  const addDate = () => {
    if (!newDate) return;
    if (dates.includes(newDate)) return;
    setDates([...dates, newDate].sort());
    setNewDate('');
  };

  const conflictCount = schedule.conflicts.length;

  return (
    <div>
      <section className="card">
        <h3>排程设置</h3>
        <div className="form-row">
          <label className="inline-field">
            每个拍摄日预计可用
            <input
              type="number"
              min={1}
              style={{ width: 90 }}
              value={dayMinutes}
              onChange={(e) => setDayMinutes(Number(e.target.value))}
            />
            分钟
          </label>
          <span className="muted small">（换场时间不计；超出当日时长的场次会标红并产生容量冲突）</span>
        </div>
        <div className="form-row">
          {dates.map((d) => (
            <span key={d} className="date-chip">
              📅 {d}
              <button
                className="ghost chip-x"
                title="移除该拍摄日"
                onClick={() => setDates(dates.filter((x) => x !== d))}
              >
                ✕
              </button>
            </span>
          ))}
          {dates.length === 0 && <span className="muted small">尚未配置拍摄日期</span>}
          <input
            type="date"
            style={{ width: 150 }}
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
          />
          <button className="ghost" onClick={addDate} disabled={!newDate || dates.includes(newDate)}>
            ＋ 添加拍摄日
          </button>
          <button className="primary" onClick={saveSettings}>
            保存设置并重算
          </button>
          <button
            onClick={() =>
              run(async () => {
                onSchedule(await api.schedule());
                setSavedAt(new Date().toLocaleTimeString());
              })
            }
          >
            ↻ 重新计算
          </button>
          {savedAt && <span className="muted small">已重算于 {savedAt}</span>}
        </div>
        <p className="muted small">
          排程由服务端按固定规则确定性现算：满足「不可提前的故事序号」与锁定场次的前提下，
          优先合并同地点场景、最小化地点切换；锁定场次固定到指定拍摄日的第 N 个拍摄位置，
          可在下方场次上直接锁定/解锁。排程不影响「故事时间线」的连续性校验。
        </p>
      </section>

      <div className="panel-bar">
        <span className={`badge ${schedule.totalSwitches ? 'badge-warn' : 'badge-ok'}`}>
          地点切换 {schedule.totalSwitches}
        </span>
        <span className="badge badge-ok">同地点合并 {schedule.totalMerges}</span>
        <span className={`badge ${conflictCount ? 'badge-danger' : 'badge-ok'}`}>
          排程冲突 {conflictCount}
        </span>
        {schedule.unscheduledCount > 0 && (
          <span className="badge badge-danger">{schedule.unscheduledCount} 场无法排入拍摄日</span>
        )}
      </div>

      {conflictCount > 0 && (
        <section className="card conflict-card">
          <h3>冲突原因（{conflictCount}）</h3>
          <ul className="conflict-list">
            {schedule.conflicts.map((c, i) => (
              <li key={i}>
                <span className="badge badge-danger">{CONFLICT_LABEL[c.type]}</span>
                <span>{c.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="schedule-days">
        {schedule.days.map((day) => (
          <DayCard
            key={day.date || 'none'}
            day={day}
            allDates={schedule.settings.dates}
            run={run}
            onSchedule={onSchedule}
          />
        ))}
      </div>
    </div>
  );
}

function DayCard({
  day,
  allDates,
  run,
  onSchedule,
}: {
  day: ScheduleDay;
  allDates: string[];
  run: Props['run'];
  onSchedule: Props['onSchedule'];
}) {
  const eventsAt = new Map<number, ScheduleDay['events']>();
  for (const e of day.events) {
    const list = eventsAt.get(e.ordinal) ?? [];
    list.push(e);
    eventsAt.set(e.ordinal, list);
  }

  return (
    <section className={`card sched-day ${day.overflow ? 'sched-day-overflow' : ''}`}>
      <div className="sched-day-head">
        <h3>
          {day.date ? `📅 ${day.date}` : '⚠ 未配置拍摄日'}
          <em className="muted small"> 第 {day.dayIndex + 1} 个拍摄日</em>
        </h3>
        <span className="spacer" />
        <span className={day.plannedMinutes > day.dayMinutes ? 'bad' : 'muted small'}>
          计划 {day.plannedMinutes}/{day.dayMinutes} 分钟
        </span>
        <span className="badge badge-warn">切换 {day.switchCount}</span>
        <span className="badge badge-ok">合并 {day.mergeCount}</span>
      </div>

      {day.items.length === 0 && (
        <p className="muted small">本日无排程场次（可能没有符合故事顺序约束的可拍场景）。</p>
      )}

      {day.items.map((it) => {
        const evs = eventsAt.get(it.ordinal) ?? [];
        return (
          <div key={it.sceneId}>
            {evs.map((ev, i) => (
              <EventLine
                key={i}
                type={ev.type}
                reason={ev.reason}
                from={ev.fromLocation}
                to={ev.toLocation}
              />
            ))}
            <div
              className={`sched-item ${it.merged ? 'sched-merged' : ''} ${
                it.orderViolation ? 'sched-violation' : ''
              } ${it.overflow ? 'sched-overflow' : ''}`}
            >
              <div className="sched-ordinal">#{it.ordinal}</div>
              <div className="sched-item-main">
                <div className="sched-item-title">
                  {it.locked && <span className="lock-chip" title="已锁定">🔒</span>}
                  <b>{it.title}</b>
                  {it.merged && <span className="badge badge-ok merge-tag">同地点合并</span>}
                  {it.orderViolation && <span className="badge badge-danger">违反故事顺序</span>}
                  {it.overflow && <span className="badge badge-danger">超出单日时长</span>}
                </div>
                <div className="sched-item-meta">
                  <span className="time-chip">{it.location || '（未填写地点）'}</span>
                  <span className="muted small">
                    故事 #{it.storyIndex}（{it.storyTime} 同刻 #{it.seq}）
                  </span>
                  {it.minStoryIndex > 0 && (
                    <span className="badge badge-warn" title="本场只能在故事线第 1..N 场全部拍完后拍摄">
                      不可早于故事 #{it.minStoryIndex}
                    </span>
                  )}
                  <span className="muted small">
                    {it.startMinute}–{it.endMinute} 分钟 · 预计 {it.estMinutes} 分钟
                  </span>
                </div>
              </div>
              <div className="sched-item-actions">
                {it.locked ? (
                  <button
                    className="ghost"
                    onClick={() =>
                      run(async () => onSchedule(await api.unlockScene(it.sceneId)))
                    }
                  >
                    🔓 解锁
                  </button>
                ) : (
                  <LockForm
                    sceneId={it.sceneId}
                    currentDate={day.date}
                    currentOrdinal={it.ordinal}
                    allDates={allDates}
                    run={run}
                    onSchedule={onSchedule}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}

      {day.events
        .filter((e) => !day.items.some((i) => i.ordinal === e.ordinal))
        .map((e, i) => (
          <EventLine
            key={`note-${i}`}
            type={e.type}
            reason={e.reason}
            from={e.fromLocation}
            to={e.toLocation}
          />
        ))}
    </section>
  );
}

function LockForm({
  sceneId,
  currentDate,
  currentOrdinal,
  allDates,
  run,
  onSchedule,
}: {
  sceneId: number;
  currentDate: string;
  currentOrdinal: number;
  allDates: string[];
  run: Props['run'];
  onSchedule: Props['onSchedule'];
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(currentDate || allDates[0] || '');
  const [ordinal, setOrdinal] = useState(currentOrdinal);

  if (!open) {
    return (
      <button className="ghost" onClick={() => setOpen(true)}>
        🔒 锁定…
      </button>
    );
  }

  return (
    <div className="lock-form">
      <select value={date} onChange={(e) => setDate(e.target.value)}>
        {allDates.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={1}
        title="当日第几个拍摄"
        value={ordinal}
        onChange={(e) => setOrdinal(Number(e.target.value))}
      />
      <button
        className="primary"
        onClick={() =>
          run(async () => {
            onSchedule(await api.lockScene(sceneId, date, ordinal));
            setOpen(false);
          })
        }
      >
        锁定
      </button>
      <button className="ghost" onClick={() => setOpen(false)}>
        取消
      </button>
    </div>
  );
}

function EventLine({
  type,
  reason,
  from,
  to,
}: {
  type: 'start' | 'switch' | 'day-continue' | 'note';
  reason: string;
  from: string;
  to: string;
}) {
  if (type === 'note') {
    return (
      <div className="sched-event sched-note">
        <span className="event-icon">⏸</span>
        <span className="muted small">{reason}</span>
      </div>
    );
  }
  if (type === 'start') {
    return (
      <div className="sched-event sched-start">
        <span className="event-icon">🎬</span>
        <span className="muted small">{reason || `从「${to || '未填写地点'}」开拍`}</span>
      </div>
    );
  }
  if (type === 'day-continue') {
    return (
      <div className="sched-event sched-continue">
        <span className="event-icon">➡️</span>
        <span className="muted small">
          跨拍摄日延续同一地点「{to || '未填写地点'}」继续拍摄（上一拍摄日收工时也在此地点，无需换场）：{reason}
        </span>
      </div>
    );
  }
  return (
    <div className="sched-event sched-switch">
      <span className="event-icon">🔀</span>
      <span className="muted small">
        <b className="bad">地点切换</b>
        {from && (
          <>
            ：{from || '未填写地点'} → {to || '未填写地点'}。
          </>
        )}{' '}
        {reason}
      </span>
    </div>
  );
}
