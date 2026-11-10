// One Pack · 定时同步（本地时间，无需 cron 服务）
// 只依赖 Node 内置模块。规则：每天在 schedule.time（本地时区）之后执行一次
// direction（默认 push）；当天已执行过就不重复，跨天且已过点则补跑一次。
export const SCHEDULE_DEFAULTS = {
  enabled: false,
  time: '18:00',
  direction: 'push',
  lastRunAt: null,
  lastError: '',
  lastOk: null,
};

/** HH:MM，24 小时制。 */
export function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

/** 把任意来源的 schedule 规范成固定结构（不抛错，供 state 读取）。 */
export function normalizeSchedule(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: base.enabled === true,
    time: isValidTime(base.time) ? base.time.trim() : SCHEDULE_DEFAULTS.time,
    direction: base.direction === 'pull' ? 'pull' : 'push',
    lastRunAt: typeof base.lastRunAt === 'string' && base.lastRunAt ? base.lastRunAt : null,
    lastError: typeof base.lastError === 'string' ? base.lastError : '',
    lastOk: typeof base.lastOk === 'boolean' ? base.lastOk : null,
  };
}

/** 本地日期键 yyyy-MM-dd，用来判断"今天是否已经跑过"。 */
export function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 是否到了该自动同步的时刻（当天过点且当天还没跑过）。 */
export function isScheduleDue(schedule, now = new Date(), lastRunAt = null) {
  if (!schedule || schedule.enabled !== true) return false;
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) return false;
  if (!isValidTime(schedule.time)) return false;
  const last = lastRunAt ?? schedule.lastRunAt;
  if (last) {
    const previous = new Date(last);
    if (!Number.isNaN(previous.getTime()) && localDayKey(previous) === localDayKey(at)) return false;
  }
  const [hours, minutes] = schedule.time.trim().split(':').map(Number);
  return at.getHours() * 60 + at.getMinutes() >= hours * 60 + minutes;
}

/** 下一次应执行的时间（用于展示），未启用时返回 null。 */
export function nextRunAt(schedule, now = new Date()) {
  if (!schedule || schedule.enabled !== true || !isValidTime(schedule.time)) return null;
  const at = now instanceof Date ? now : new Date(now);
  const [hours, minutes] = schedule.time.trim().split(':').map(Number);
  const next = new Date(at.getTime());
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1);
  return next;
}