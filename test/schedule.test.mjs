// One Pack · 定时同步与 state 持久化
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEDULE_DEFAULTS,
  isScheduleDue,
  isValidTime,
  localDayKey,
  nextRunAt,
  normalizeSchedule,
} from '../lib/schedule.mjs';
import { StateStore } from '../lib/state.mjs';
import { SyncEngine } from '../lib/orchestrator.mjs';

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'one-pack-schedule-'));
  const store = new StateStore({ file: join(dir, 'state.json') });
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('normalizeSchedule fills defaults and rejects garbage', () => {
  const empty = normalizeSchedule(null);
  assert.equal(empty.enabled, false);
  assert.equal(empty.time, SCHEDULE_DEFAULTS.time);
  assert.equal(empty.direction, 'push');
  assert.equal(empty.lastRunAt, null);
  assert.equal(empty.lastError, '');
  assert.equal(empty.lastOk, null);

  const given = normalizeSchedule({
    enabled: true,
    time: '07:05',
    direction: 'pull',
    lastRunAt: '2026-01-05T10:00:00.000Z',
    lastError: 'boom',
    lastOk: false,
  });
  assert.deepEqual(given, {
    enabled: true,
    time: '07:05',
    direction: 'pull',
    lastRunAt: '2026-01-05T10:00:00.000Z',
    lastError: 'boom',
    lastOk: false,
  });

  const bad = normalizeSchedule({ enabled: 'yes', time: '25:99', direction: 'sideways', lastOk: 'nope' });
  assert.equal(bad.enabled, false);
  assert.equal(bad.time, '18:00');
  assert.equal(bad.direction, 'push');
  assert.equal(bad.lastOk, null);
});

test('isValidTime accepts only 24h HH:MM', () => {
  for (const value of ['00:00', '07:05', '18:00', '23:59']) assert.equal(isValidTime(value), true, value);
  for (const value of ['', '7:5', '24:00', '18:60', '18:0', 'a8:00', null, undefined]) {
    assert.equal(isValidTime(value), false, String(value));
  }
});

test('isScheduleDue respects enabled, time and once-per-day', () => {
  const schedule = normalizeSchedule({ enabled: true, time: '18:00' });
  assert.equal(isScheduleDue(schedule, new Date(2026, 0, 5, 17, 59)), false);
  assert.equal(isScheduleDue(schedule, new Date(2026, 0, 5, 18, 0)), true);
  assert.equal(isScheduleDue(schedule, new Date(2026, 0, 5, 23, 59)), true);
  assert.equal(
    isScheduleDue(schedule, new Date(2026, 0, 5, 20, 0), new Date(2026, 0, 5, 18, 2).toISOString()),
    false,
  );
  assert.equal(
    isScheduleDue(schedule, new Date(2026, 0, 6, 18, 1), new Date(2026, 0, 5, 18, 2).toISOString()),
    true,
  );
  assert.equal(isScheduleDue(normalizeSchedule({ enabled: false, time: '00:00' }), new Date(2026, 0, 5, 23, 0)), false);
  assert.equal(isScheduleDue({ enabled: true, time: 'bad' }, new Date(2026, 0, 5, 23, 0)), false);
});

test('nextRunAt returns today or tomorrow', () => {
  const schedule = normalizeSchedule({ enabled: true, time: '18:00' });
  const today = nextRunAt(schedule, new Date(2026, 0, 5, 9, 0));
  assert.equal(localDayKey(today), '2026-01-05');
  assert.equal(today.getHours(), 18);
  const tomorrow = nextRunAt(schedule, new Date(2026, 0, 5, 19, 0));
  assert.equal(localDayKey(tomorrow), '2026-01-06');
  assert.equal(nextRunAt(normalizeSchedule({ enabled: false }), new Date()), null);
});

test('state persists schedule with defaults', () => {
  const { store, cleanup } = tempState();
  try {
    const first = store.read();
    assert.equal(first.schedule.enabled, false);
    assert.equal(first.schedule.time, '18:00');
    assert.equal(first.schedule.direction, 'push');

    store.update((current) => ({ ...current, schedule: { ...current.schedule, enabled: true, time: '07:30' } }));
    const second = store.read();
    assert.equal(second.schedule.enabled, true);
    assert.equal(second.schedule.time, '07:30');
  } finally {
    cleanup();
  }
});

test('updateSchedule validates and persists', async () => {
  const { store, cleanup } = tempState();
  try {
    const engine = new SyncEngine({ store, svc: {} });
    const enabled = await engine.updateSchedule({ enabled: true, time: '18:00' });
    assert.equal(enabled.enabled, true);
    assert.equal(store.read().schedule.time, '18:00');

    await assert.rejects(() => engine.updateSchedule({ time: '25:00' }), (err) => err.code === 'INVALID_SCHEDULE');
    await assert.rejects(() => engine.updateSchedule({ enabled: 'yes' }), (err) => err.code === 'INVALID_SCHEDULE');
    await assert.rejects(() => engine.updateSchedule({ direction: 'both' }), (err) => err.code === 'INVALID_SCHEDULE');
    assert.equal(store.read().schedule.time, '18:00');
  } finally {
    cleanup();
  }
});

test('tickSchedule is a no-op before the scheduled time and records failures', async () => {
  const { store, cleanup } = tempState();
  try {
    store.update((current) => ({
      ...current,
      repo: 'octo/one-pack',
      schedule: { ...current.schedule, enabled: true, time: '18:00' },
    }));
    const engine = new SyncEngine({ store, svc: {} });
    assert.equal(await engine.tickSchedule(new Date(2026, 0, 5, 9, 0)), null);

    // Due time, but no credentials service → NO_TOKEN is recorded once, then the
    // day is spent so a later tick does not retry.
    assert.equal(await engine.tickSchedule(new Date(2026, 0, 5, 18, 0)), null);
    const state = store.read();
    assert.equal(state.schedule.lastOk, false);
    assert.match(state.schedule.lastError, /NO_TOKEN/);
    assert.equal(await engine.tickSchedule(new Date(2026, 0, 5, 18, 30)), null);
  } finally {
    cleanup();
  }
});