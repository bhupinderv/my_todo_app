import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankTasks, topTasks, suggestPriority, effectivePriority, scoreTask, suggestedPosition,
  suggestedOrder, summarize, between, isOverdue, urgencyPoints,
} from '../js/prioritization.js';
import { daysBetween, addDays, snoozeUntil, isValidISODate } from '../js/dates.js';

const today = '2026-09-27';
const now = new Date('2026-09-27T09:00:00');

let seq = 0;
const task = (overrides = {}) => ({
  id: `t${++seq}`,
  title: 'Task',
  category: 'other',
  status: 'TODO',
  due_date: null,
  user_priority: null,
  effort_minutes: null,
  pinned: false,
  position: seq * 1000,
  snoozed_until: null,
  postpone_count: 0,
  ...overrides,
});

const titles = (ranked) => ranked.map((r) => r.task.title);

test('dates: day arithmetic crosses month and DST boundaries', () => {
  assert.equal(daysBetween('2026-09-27', '2026-10-01'), 4);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2); // EU DST change
  assert.equal(daysBetween('2026-09-27', '2026-09-26'), -1);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.ok(isValidISODate('2026-02-28'));
  assert.ok(!isValidISODate('2026-02-30'));
  assert.ok(!isValidISODate('tomorrow'));
});

test('snooze options land on sensible times', () => {
  const sunday = new Date('2026-09-27T21:00:00');
  assert.equal(snoozeUntil('tomorrow', sunday).getDate(), 28);
  assert.equal(snoozeUntil('tomorrow', sunday).getHours(), 8);
  const nextWeek = snoozeUntil('nextweek', sunday);
  assert.equal(nextWeek.getDay(), 1); // Monday…
  assert.equal(nextWeek.getDate(), 5); // …but not tomorrow's
  const monday = new Date('2026-09-28T10:00:00');
  assert.equal(snoozeUntil('nextweek', monday).getDate(), 5); // the following Monday, not today
});

test('urgency: overdue > today > tomorrow > this week > later > no date', () => {
  const values = [-2, 0, 1, 5, 12, 30, null].map(urgencyPoints);
  const sorted = [...values].sort((a, b) => b - a);
  assert.deepEqual(values, sorted);
  assert.ok(urgencyPoints(-5) > urgencyPoints(-1), 'longer overdue ranks higher');
});

test('suggested priority comes from urgency; user priority always wins', () => {
  assert.equal(suggestPriority(task({ due_date: addDays(today, -1) }), today), 'HIGH');
  assert.equal(suggestPriority(task({ due_date: addDays(today, 1) }), today), 'HIGH');
  assert.equal(suggestPriority(task({ due_date: addDays(today, 5) }), today), 'MEDIUM');
  assert.equal(suggestPriority(task({ status: 'IN_PROGRESS' }), today), 'MEDIUM');
  assert.equal(suggestPriority(task({ postpone_count: 3 }), today), 'MEDIUM');
  assert.equal(suggestPriority(task(), today), 'LOW');

  const overdueButLow = task({ due_date: addDays(today, -1), user_priority: 'LOW' });
  assert.equal(effectivePriority(overdueButLow, today), 'LOW');
});

test('user priority changes the score', () => {
  const base = { due_date: addDays(today, 10) };
  const high = scoreTask(task({ ...base, user_priority: 'HIGH' }), { today }).score;
  const low = scoreTask(task({ ...base, user_priority: 'LOW' }), { today }).score;
  assert.ok(high > low);
});

test('Top 3: overdue and due-today tasks come before later ones', () => {
  const tasks = [
    task({ title: 'later', due_date: addDays(today, 20) }),
    task({ title: 'today', due_date: today }),
    task({ title: 'none' }),
    task({ title: 'overdue', due_date: addDays(today, -2) }),
  ];
  assert.deepEqual(titles(topTasks(tasks, { today, now })), ['overdue', 'today', 'later']);
});

test('in-progress work gets a boost over an equal fresh task', () => {
  const tasks = [
    task({ title: 'fresh', due_date: addDays(today, 3) }),
    task({ title: 'started', due_date: addDays(today, 3), status: 'IN_PROGRESS' }),
  ];
  assert.equal(rankTasks(tasks, { today, now })[0].task.title, 'started');
});

test('done and snoozed tasks are excluded; snooze expiry makes them eligible again', () => {
  const snoozed = task({ title: 'snoozed', due_date: today, snoozed_until: '2026-09-27T12:00:00' });
  const tasks = [task({ title: 'done', status: 'DONE', due_date: today }), snoozed, task({ title: 'plain' })];
  assert.deepEqual(titles(rankTasks(tasks, { today, now })), ['plain']);

  const afterExpiry = new Date('2026-09-27T12:01:00');
  assert.deepEqual(titles(rankTasks(tasks, { today, now: afterExpiry })), ['snoozed', 'plain']);
});

test('pinned tasks always lead the Top 3, in the user\'s order', () => {
  const tasks = [
    task({ title: 'urgent', due_date: addDays(today, -3), user_priority: 'HIGH' }),
    task({ title: 'pinned-b', pinned: true }),
    task({ title: 'pinned-a', pinned: true, position: 1 }),
  ];
  assert.deepEqual(titles(topTasks(tasks, { today, now })), ['pinned-a', 'pinned-b', 'urgent']);
});

test('manual position breaks ties and is a real signal', () => {
  const a = task({ title: 'a', position: 2000 });
  const b = task({ title: 'b', position: 1000 });
  assert.deepEqual(titles(rankTasks([a, b], { today, now })), ['b', 'a']);
  // A small urgency difference can be outweighed by moving a task to the top.
  const top = task({ title: 'moved-up', position: 0, due_date: addDays(today, 20) });
  const other = task({ title: 'other', position: 5000, due_date: addDays(today, 9) });
  assert.equal(rankTasks([other, top], { today, now })[0].task.title, 'moved-up');
});

test('repeated postponing slowly raises a task', () => {
  const fresh = scoreTask(task(), { today }).score;
  const postponed = scoreTask(task({ postpone_count: 3 }), { today }).score;
  assert.ok(postponed > fresh);
});

test('reasons explain the recommendation', () => {
  const [top] = rankTasks([task({ due_date: addDays(today, -1), status: 'IN_PROGRESS', effort_minutes: 15 })], { today, now });
  assert.ok(top.reasons.includes('Overdue by 1 day'));
  assert.ok(top.reasons.includes('Already in progress'));
  assert.ok(top.reasons.includes('Quick win'));
});

test('new tasks are placed before the first task they outrank', () => {
  const tasks = [
    task({ title: 'overdue', position: 1000, due_date: addDays(today, -1) }),
    task({ title: 'someday', position: 2000 }),
  ];
  const pos = suggestedPosition(task({ due_date: today }), tasks, today);
  assert.ok(pos > 1000 && pos < 2000);
  const last = suggestedPosition(task({ user_priority: 'LOW' }), tasks, today);
  assert.ok(last > 2000);
  assert.equal(suggestedPosition(task(), [], today), 1000);
});

test('suggested order puts pinned first then score, skipping done', () => {
  const tasks = [
    task({ title: 'done', status: 'DONE' }),
    task({ title: 'low' }),
    task({ title: 'today', due_date: today }),
    task({ title: 'pinned', pinned: true }),
  ];
  assert.deepEqual(suggestedOrder(tasks, today).map((t) => t.title), ['pinned', 'today', 'low']);
});

test('between() always lands strictly between neighbours', () => {
  assert.equal(between(1000, 2000), 1500);
  assert.ok(between(null, 1000) < 1000);
  assert.ok(between(1000, null) > 1000);
});

test('briefing counts: overdue stays overdue even when snoozed', () => {
  const tasks = [
    task({ due_date: addDays(today, -1), snoozed_until: '2026-09-28T08:00:00' }),
    task({ due_date: addDays(today, -4) }),
    task({ due_date: addDays(today, -4), status: 'DONE' }),
    task({ due_date: today }),
    task({ status: 'IN_PROGRESS' }),
  ];
  const s = summarize(tasks, { today, now });
  assert.equal(s.overdue.length, 2);
  assert.equal(s.dueToday.length, 1);
  assert.equal(s.inProgress.length, 1);
  assert.equal(s.snoozed.length, 1);
  assert.ok(!isOverdue(tasks[2], today));
});
