// Recommendation engine, V1: transparent, rule-based scoring.
//
// Kept free of DOM and database code so it can be unit-tested and later
// replaced by something smarter (e.g. weights learned from task history)
// without touching the UI. Every function takes `today` ("YYYY-MM-DD") and/or
// `now` (Date) explicitly so results are deterministic.
//
// Two separate ideas:
//   * suggested priority (HIGH/MEDIUM/LOW) — what the app thinks, from urgency.
//     The user's own priority, when set, always wins (effectivePriority).
//   * focus score — a number used to rank tasks for the Top 3. Each score
//     comes with human-readable reasons so the app can explain itself.

import { daysBetween } from './dates.js';

export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];

export const WEIGHTS = {
  priority: { HIGH: 30, MEDIUM: 15, LOW: 0 },
  inProgress: 25,        // finish what you started
  postponePerTime: 4,    // repeatedly postponed tasks slowly float up
  postponeMax: 12,
  quickWin: 4,           // effort <= 30 min
  bigTaskDueSoon: 6,     // effort >= 2 h and due within 3 days: start early
  positionMax: 15,       // top of the user's manual list; decays to 0 at the bottom
};

export const QUICK_WIN_MINUTES = 30;
export const BIG_TASK_MINUTES = 120;

export function dueInDays(task, today) {
  return task.due_date ? daysBetween(today, task.due_date) : null;
}

export function isOpen(task) {
  return task.status !== 'DONE';
}

export function isOverdue(task, today) {
  const d = dueInDays(task, today);
  return isOpen(task) && d !== null && d < 0;
}

export function isDueToday(task, today) {
  return isOpen(task) && dueInDays(task, today) === 0;
}

export function isSnoozed(task, now) {
  return Boolean(task.snoozed_until) && new Date(task.snoozed_until) > now;
}

/** Points for how close the due date is. Overdue keeps growing (capped). */
export function urgencyPoints(days) {
  if (days === null) return 0;
  if (days < 0) return 50 + Math.min(-days, 10) * 2;
  if (days === 0) return 40;
  if (days === 1) return 30;
  if (days <= 3) return 20;
  if (days <= 7) return 10;
  if (days <= 14) return 4;
  return 0;
}

/** The app's opinion of a task's priority, ignoring what the user chose. */
export function suggestPriority(task, today) {
  const d = dueInDays(task, today);
  if (d !== null && d <= 1) return 'HIGH';
  if ((d !== null && d <= 7) || task.status === 'IN_PROGRESS' || (task.postpone_count ?? 0) >= 3) {
    return 'MEDIUM';
  }
  return 'LOW';
}

/** The user's choice wins; otherwise fall back to the suggestion. */
export function effectivePriority(task, today) {
  return task.user_priority ?? suggestPriority(task, today);
}

/**
 * Score one task. `rank`/`total` describe its place in the user's manual
 * order among eligible tasks; omit them to score without the position signal.
 */
export function scoreTask(task, { today, rank = null, total = 0 }) {
  const reasons = [];
  let score = 0;

  const d = dueInDays(task, today);
  score += urgencyPoints(d);
  if (d !== null) {
    if (d < 0) reasons.push(`Overdue by ${-d} day${d === -1 ? '' : 's'}`);
    else if (d === 0) reasons.push('Due today');
    else if (d === 1) reasons.push('Due tomorrow');
    else if (d <= 7) reasons.push(`Due in ${d} days`);
  }

  const priority = effectivePriority(task, today);
  score += WEIGHTS.priority[priority];
  if (task.user_priority) reasons.push(`You set ${priority}`);

  if (task.status === 'IN_PROGRESS') {
    score += WEIGHTS.inProgress;
    reasons.push('Already in progress');
  }

  const postponed = task.postpone_count ?? 0;
  if (postponed > 0) {
    score += Math.min(postponed * WEIGHTS.postponePerTime, WEIGHTS.postponeMax);
    if (postponed >= 2) reasons.push(`Postponed ${postponed}×`);
  }

  const effort = task.effort_minutes;
  if (effort && effort <= QUICK_WIN_MINUTES) {
    score += WEIGHTS.quickWin;
    reasons.push('Quick win');
  } else if (effort && effort >= BIG_TASK_MINUTES && d !== null && d <= 3) {
    score += WEIGHTS.bigTaskDueSoon;
    reasons.push('Big task, due soon — start early');
  }

  if (rank !== null && total > 1) {
    score += WEIGHTS.positionMax * (1 - rank / (total - 1));
    if (rank < 3) reasons.push('High in your list');
  }

  return { score: Math.round(score * 10) / 10, reasons };
}

const byPosition = (a, b) => a.position - b.position;

/** Pinned tasks first (in the user's order), then highest score. */
function compareRanked(a, b) {
  if (a.task.pinned !== b.task.pinned) return a.task.pinned ? -1 : 1;
  if (a.task.pinned) return byPosition(a.task, b.task);
  return b.score - a.score || byPosition(a.task, b.task);
}

/** Open, non-snoozed tasks, best first, each with { task, score, reasons }. */
export function rankTasks(tasks, { today, now }) {
  const eligible = tasks.filter((t) => isOpen(t) && !isSnoozed(t, now)).sort(byPosition);
  return eligible
    .map((task, rank) => {
      const { score, reasons } = scoreTask(task, { today, rank, total: eligible.length });
      if (task.pinned) reasons.unshift('Pinned by you');
      return { task, score, reasons };
    })
    .sort(compareRanked);
}

export function topTasks(tasks, opts, n = 3) {
  return rankTasks(tasks, opts).slice(0, n);
}

/** Order the app would suggest for the whole list (no position signal). */
export function suggestedOrder(tasks, today) {
  return tasks
    .filter(isOpen)
    .map((task) => ({ task, score: scoreTask(task, { today }).score }))
    .sort(compareRanked)
    .map((x) => x.task);
}

/** Midpoint between two positions; either side may be missing. */
export function between(before, after) {
  if (before == null && after == null) return 1000;
  if (before == null) return after - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

/**
 * Where a new task should go in the user's manual list: just before the first
 * open task it outranks. A starting point only — after that the user decides.
 */
export function suggestedPosition(newTask, tasks, today) {
  const open = tasks.filter(isOpen).sort(byPosition);
  if (open.length === 0) return between(null, null);
  const newScore = scoreTask(newTask, { today }).score;
  const i = open.findIndex((t) => !t.pinned && scoreTask(t, { today }).score < newScore);
  if (i === -1) return between(Math.max(...tasks.map((t) => t.position)), null);
  return between(open[i - 1]?.position, open[i].position);
}

/** The numbers behind the daily briefing. */
export function summarize(tasks, { today, now }) {
  const open = tasks.filter(isOpen);
  return {
    open,
    overdue: open.filter((t) => isOverdue(t, today)).sort((a, b) => a.due_date.localeCompare(b.due_date)),
    dueToday: open.filter((t) => isDueToday(t, today)),
    inProgress: open.filter((t) => t.status === 'IN_PROGRESS'),
    snoozed: open.filter((t) => isSnoozed(t, now)),
  };
}
