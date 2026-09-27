import { tasksApi as api, auth, isDemo, resetDemoData } from './store.js';
import {
  todayISO, formatDue, relativeTime, formatWhen, snoozeUntil, SNOOZE_OPTIONS, isValidISODate,
} from './dates.js';
import {
  rankTasks, summarize, suggestPriority, effectivePriority, isOverdue, isSnoozed,
  suggestedPosition, suggestedOrder, between,
} from './prioritization.js';
import { enableDragSort, isDragging } from './dnd.js';

const CATEGORIES = {
  work: 'Work',
  cooking: 'Cooking',
  household: 'Household',
  study: 'Study',
  errands: 'Errands',
  other: 'Other',
};

const state = {
  user: null,
  tasks: [],
  loading: true,
  loadError: null,
  filter: 'all',
};

let editingId = null;
let snoozingId = null;
let renderPending = false;

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const byPosition = (a, b) => a.position - b.position;
const sortedTasks = () => [...state.tasks].sort(byPosition);
const findTask = (id) => state.tasks.find((t) => t.id === id);
const isPending = (task) => String(task.id).startsWith('tmp-');

function replaceTask(task) {
  const i = state.tasks.findIndex((t) => t.id === task.id);
  if (i !== -1) state.tasks[i] = task;
}

function formatEffort(minutes) {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

function statusPatch(task, status) {
  const now = new Date().toISOString();
  const patch = { status };
  if (status === 'IN_PROGRESS') {
    if (!task.started_at) patch.started_at = now;
    patch.snoozed_until = null;
  }
  if (status === 'DONE') {
    patch.completed_at = now;
    patch.snoozed_until = null;
  } else {
    patch.completed_at = null;
  }
  return patch;
}

// ---------- toast ----------

let toastTimer = null;
function toast(message, { type = 'info', action } = {}) {
  const el = $('#toast');
  el.className = `toast show ${type}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn small ghost';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { hideToast(); action.run(); });
    el.append(btn);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, type === 'error' ? 7000 : 4000);
}

function hideToast() {
  $('#toast').className = 'toast';
}

// ---------- data operations (optimistic; roll back on failure) ----------

async function loadTasks({ quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    render();
  }
  try {
    state.tasks = await api.list();
    state.loadError = null;
  } catch (e) {
    if (!quiet || state.tasks.length === 0) state.loadError = e.message;
  }
  state.loading = false;
  render();
  syncSuggestedPriorities();
}

/** Store the app's current suggestion so future versions can learn from overrides. */
function syncSuggestedPriorities() {
  const today = todayISO();
  for (const t of state.tasks) {
    if (t.status === 'DONE' || isPending(t)) continue;
    const suggested = suggestPriority(t, today);
    if (suggested !== t.suggested_priority) {
      api.update(t.id, { suggested_priority: suggested }).then(replaceTask).catch(() => {});
    }
  }
}

async function createTask(fields) {
  const today = todayISO();
  const now = new Date().toISOString();
  const draft = { category: 'other', status: 'TODO', pinned: false, postpone_count: 0, ...fields };
  draft.suggested_priority = suggestPriority(draft, today);
  draft.position = suggestedPosition(draft, state.tasks, today);
  if (draft.status === 'IN_PROGRESS') draft.started_at = now;
  if (draft.status === 'DONE') draft.completed_at = now;

  const temp = { ...draft, id: `tmp-${crypto.randomUUID()}`, created_at: now, updated_at: now };
  state.tasks.push(temp);
  render();
  try {
    const saved = await api.create(draft);
    state.tasks = state.tasks.map((t) => (t.id === temp.id ? saved : t));
    render();
    toast(`Added “${saved.title}”`);
  } catch (e) {
    state.tasks = state.tasks.filter((t) => t.id !== temp.id);
    render();
    toast(`Couldn’t add task: ${e.message}`, { type: 'error' });
  }
}

async function updateTask(id, patch) {
  const before = findTask(id);
  if (!before || isPending(before)) return null;
  const suggested = suggestPriority({ ...before, ...patch }, todayISO());
  if (suggested !== before.suggested_priority) patch = { ...patch, suggested_priority: suggested };

  replaceTask({ ...before, ...patch });
  render();
  try {
    const saved = await api.update(id, patch);
    replaceTask(saved);
    render();
    return saved;
  } catch (e) {
    replaceTask(before);
    render();
    toast(`Couldn’t save: ${e.message}`, { type: 'error' });
    return null;
  }
}

async function deleteTask(id) {
  const task = findTask(id);
  state.tasks = state.tasks.filter((t) => t.id !== id);
  render();
  try {
    await api.remove(id);
    toast(`Deleted “${task.title}”`);
  } catch (e) {
    state.tasks.push(task);
    render();
    toast(`Couldn’t delete: ${e.message}`, { type: 'error' });
  }
}

async function completeTask(task) {
  const previous = { status: task.status, completed_at: task.completed_at, snoozed_until: task.snoozed_until };
  const saved = await updateTask(task.id, statusPatch(task, 'DONE'));
  if (saved) {
    toast(`Done: ${task.title}`, { type: 'success', action: { label: 'Undo', run: () => updateTask(task.id, previous) } });
  }
}

async function moveTask(id) {
  const ids = [...$('#task-list').children].map((el) => el.dataset.id).filter(Boolean);
  const i = ids.indexOf(id);
  let prev = findTask(ids[i - 1]);
  let next = findTask(ids[i + 1]);
  if (prev && next && next.position - prev.position < 1e-6) {
    await renumber(sortedTasks().filter((t) => t.status !== 'DONE'));
    prev = findTask(ids[i - 1]);
    next = findTask(ids[i + 1]);
  }
  return updateTask(id, { position: between(prev?.position, next?.position) });
}

/** Give tasks fresh, evenly spaced positions in the given order. */
function renumber(orderedTasks) {
  return Promise.all(orderedTasks.map((t, i) => updateTask(t.id, { position: (i + 1) * 1000 })));
}

async function applySuggestedOrder() {
  const ok = confirm('Reorder your list the way the app suggests?\n\nYour current manual order will be replaced. Pinned tasks stay on top.');
  if (!ok) return;
  await renumber(suggestedOrder(state.tasks, todayISO()));
  toast('List reordered by suggestion');
}

// ---------- rendering ----------

function render() {
  if (isDragging()) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const today = todayISO();
  const now = new Date();
  const ranked = rankTasks(state.tasks, { today, now });
  const top = ranked.slice(0, 3);
  renderBriefing(today, now, top);
  renderTop(today, now, top, ranked.length);
  renderList(today, now);
  renderDone();
}

function greeting(now) {
  const h = now.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function badges(task, today, now) {
  const out = [];
  if (task.status === 'IN_PROGRESS') out.push('<span class="badge status">In progress</span>');
  if (task.due_date) {
    const due = formatDue(task.due_date, today);
    out.push(`<span class="badge due ${due.tone}">${esc(due.label)}</span>`);
  }
  const p = effectivePriority(task, today);
  const source = task.user_priority ? 'Set by you' : 'Suggested by the app — edit the task to override';
  out.push(`<span class="badge prio prio-${p.toLowerCase()}" title="${source}">${p}${task.user_priority ? '' : '<small>&nbsp;·&nbsp;auto</small>'}</span>`);
  out.push(`<span class="badge cat cat-${esc(task.category)}">${esc(CATEGORIES[task.category] ?? task.category)}</span>`);
  if (task.effort_minutes) out.push(`<span class="badge plain">${formatEffort(task.effort_minutes)}</span>`);
  if (isSnoozed(task, now)) out.push(`<span class="badge snooze">Snoozed until ${esc(formatWhen(task.snoozed_until, now))}</span>`);
  if (task.pinned) out.push('<span class="badge pin">Pinned</span>');
  return out.join('');
}

const button = (action, label, extra = '') => (
  `<button type="button" class="btn small ${extra}" data-action="${action}">${label}</button>`
);

function renderBriefing(today, now, top) {
  const el = $('#briefing');
  if (state.loading && state.tasks.length === 0) {
    el.innerHTML = '<p class="greeting">Loading your day…</p><div class="skeleton"></div>';
    return;
  }
  if (state.loadError) {
    el.innerHTML = `
      <p class="greeting">Couldn’t load your tasks.</p>
      <p class="summary muted">${esc(state.loadError)}</p>
      ${button('retry', 'Try again', 'primary')}`;
    return;
  }

  const s = summarize(state.tasks, { today, now });
  const parts = [];
  if (s.overdue.length) parts.push(`<strong class="text-overdue">${plural(s.overdue.length, 'overdue task')}</strong>`);
  if (s.dueToday.length) parts.push(`<strong>${plural(s.dueToday.length, 'task')} due today</strong>`);
  let summary = parts.length
    ? `You have ${parts.join(' and ')}.`
    : s.open.length ? 'Nothing is overdue or due today.' : 'Your list is empty — add something below.';
  if (s.inProgress.length) summary += ` You’re in the middle of ${plural(s.inProgress.length, 'task')}.`;
  if (s.snoozed.length) summary += ` <span class="muted">${s.snoozed.length} snoozed.</span>`;

  let html = `<p class="greeting">${greeting(now)}.</p><p class="summary">${summary}</p>`;

  if (s.overdue.length) {
    html += `
      <div class="attention" role="alert">
        <h3>Action required</h3>
        <p class="small">Overdue tasks stay overdue until you decide: do it, finish it, or pick a new date.</p>
        <ul class="compact-list">
          ${s.overdue.map((t) => `
            <li data-id="${t.id}">
              <span class="compact-title">${esc(t.title)}</span>
              <span class="badge due overdue">${esc(formatDue(t.due_date, today).label)}</span>
              <span class="compact-actions">
                ${t.status === 'IN_PROGRESS' ? '' : button('start', 'Start')}
                ${button('done', 'Done')}
                ${button('reschedule', 'New date')}
              </span>
            </li>`).join('')}
        </ul>
      </div>`;
  }

  const topIds = new Set(top.map((x) => x.task.id));
  const unfinished = s.inProgress.filter((t) => !topIds.has(t.id));
  if (unfinished.length) {
    html += `
      <div class="continue">
        <h3>Don’t forget — still in progress</h3>
        <ul class="compact-list">
          ${unfinished.map((t) => `
            <li data-id="${t.id}">
              <span class="compact-title">${esc(t.title)}</span>
              ${t.started_at ? `<span class="small muted">started ${relativeTime(t.started_at, now)}</span>` : ''}
              <span class="compact-actions">${button('done', 'Done')}${button('pause', 'Pause')}</span>
            </li>`).join('')}
        </ul>
      </div>`;
  }
  el.innerHTML = html;
}

function renderTop(today, now, top, eligibleCount) {
  const el = $('#top3');
  if (state.loading && state.tasks.length === 0) {
    el.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
    return;
  }
  if (top.length === 0) {
    const open = state.tasks.filter((t) => t.status !== 'DONE').length;
    const msg = open
      ? 'Everything open is snoozed. It’ll come back when the snooze ends.'
      : 'Nothing to recommend. Add a task below — or enjoy the free time.';
    el.innerHTML = `<li class="empty">${msg}</li>`;
    return;
  }
  el.innerHTML = top.map(({ task, reasons }, i) => {
    const p = effectivePriority(task, today).toLowerCase();
    const inProgress = task.status === 'IN_PROGRESS';
    return `
      <li class="top-card prio-${p} ${isOverdue(task, today) ? 'is-overdue' : ''} ${inProgress ? 'is-active' : ''}" data-id="${task.id}">
        <span class="rank" aria-hidden="true">${i + 1}</span>
        <div class="top-body">
          <div class="task-title">${esc(task.title)}</div>
          <div class="meta">${badges(task, today, now)}</div>
          ${reasons.length ? `<div class="why"><span class="muted">Why:</span> ${esc(reasons.join(' · '))}</div>` : ''}
        </div>
        <div class="top-actions">
          ${inProgress ? button('done', 'Done', 'primary') : button('start', 'Start', 'primary')}
          ${inProgress ? '' : button('done', 'Done')}
          ${button('snooze', 'Not now', 'ghost')}
          ${button('pin', task.pinned ? 'Unpin' : 'Pin', 'ghost')}
        </div>
      </li>`;
  }).join('');
  if (eligibleCount > 3) {
    el.insertAdjacentHTML('beforeend', `<li class="top-note small muted">Disagree? Pin the task you want here, or drag it up in your list. ${eligibleCount - 3} more below.</li>`);
  }
}

function renderList(today, now) {
  const el = $('#task-list');
  if (state.loading && state.tasks.length === 0) {
    el.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li>';
    return;
  }
  const open = sortedTasks().filter((t) => t.status !== 'DONE');
  const visible = open.filter((t) => state.filter === 'all' || t.category === state.filter);
  if (visible.length === 0) {
    el.innerHTML = `<li class="empty">${open.length ? 'No open tasks in this category.' : 'No open tasks. Capture one above.'}</li>`;
    return;
  }
  el.innerHTML = visible.map((t) => {
    const classes = ['task-row'];
    if (isOverdue(t, today)) classes.push('is-overdue');
    if (t.status === 'IN_PROGRESS') classes.push('is-active');
    if (isSnoozed(t, now)) classes.push('is-snoozed');
    if (isPending(t)) classes.push('is-pending');
    return `
      <li class="${classes.join(' ')}" data-id="${t.id}">
        <button type="button" class="drag-handle" aria-label="Reorder “${esc(t.title)}” (drag, or use arrow keys)" title="Drag to reorder">
          <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></g></svg>
        </button>
        <input type="checkbox" class="check" data-action="toggle-done" aria-label="Mark “${esc(t.title)}” done">
        <div class="row-main">
          <button type="button" class="task-title link" data-action="edit">${esc(t.title)}</button>
          <div class="meta">${badges(t, today, now)}</div>
        </div>
        <div class="row-actions">
          ${t.status === 'IN_PROGRESS' ? button('pause', 'Pause', 'ghost') : button('start', 'Start', 'ghost')}
          ${button('snooze', 'Snooze', 'ghost')}
        </div>
      </li>`;
  }).join('');
}

function renderDone() {
  const done = state.tasks
    .filter((t) => t.status === 'DONE')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  $('#done-count').textContent = done.length;
  $('#done-section').hidden = done.length === 0;
  const now = new Date();
  $('#done-list').innerHTML = done.slice(0, 50).map((t) => `
    <li class="task-row is-done" data-id="${t.id}">
      <input type="checkbox" class="check" data-action="toggle-done" checked aria-label="Reopen “${esc(t.title)}”">
      <div class="row-main">
        <button type="button" class="task-title link" data-action="edit">${esc(t.title)}</button>
        <div class="meta"><span class="badge cat cat-${esc(t.category)}">${esc(CATEGORIES[t.category] ?? t.category)}</span>
          ${t.completed_at ? `<span class="small muted">completed ${relativeTime(t.completed_at, now)}</span>` : ''}</div>
      </div>
    </li>`).join('');
}

// ---------- dialogs ----------

function updateAutoPriorityLabel() {
  const f = $('#task-form').elements;
  const draft = {
    ...(editingId ? findTask(editingId) : {}),
    due_date: f.due_date.value || null,
    status: f.status.value,
  };
  f.user_priority.options[0].textContent = `Auto (suggests ${suggestPriority(draft, todayISO())})`;
}

function openEditor(task = null, { title = '', focus = 'title' } = {}) {
  editingId = task?.id ?? null;
  const form = $('#task-form');
  form.reset();
  const f = form.elements;
  $('#dialog-title').textContent = task ? 'Edit task' : 'New task';
  f.title.value = task?.title ?? title;
  f.category.value = task?.category ?? (state.filter !== 'all' ? state.filter : 'other');
  f.due_date.value = task?.due_date ?? '';
  f.user_priority.value = task?.user_priority ?? '';
  f.status.value = task?.status ?? 'TODO';
  f.effort_minutes.value = task?.effort_minutes ?? '';
  f.notes.value = task?.notes ?? '';
  f.pinned.checked = task?.pinned ?? false;
  $('#delete-task').hidden = !task;
  $('#form-error').textContent = '';
  const meta = $('#task-meta');
  meta.textContent = task
    ? `Created ${relativeTime(task.created_at)}${task.postpone_count ? ` · postponed ${task.postpone_count}×` : ''}`
    : '';
  updateAutoPriorityLabel();
  $('#task-dialog').showModal();
  f[focus].focus();
}

function readTaskForm() {
  const f = $('#task-form').elements;
  const title = f.title.value.trim();
  if (!title) return { error: 'Give the task a title.' };
  if (title.length > 200) return { error: 'Keep the title under 200 characters.' };
  const due = f.due_date.value;
  if (due && !isValidISODate(due)) return { error: 'That due date doesn’t look right.' };
  return {
    fields: {
      title,
      category: f.category.value,
      due_date: due || null,
      user_priority: f.user_priority.value || null,
      status: f.status.value,
      effort_minutes: f.effort_minutes.value ? Number(f.effort_minutes.value) : null,
      notes: f.notes.value.trim() || null,
      pinned: f.pinned.checked,
    },
  };
}

function saveTaskForm(e) {
  e.preventDefault();
  const { fields, error } = readTaskForm();
  if (error) {
    $('#form-error').textContent = error;
    return;
  }
  $('#task-dialog').close();
  if (!editingId) return createTask(fields);

  const task = findTask(editingId);
  const patch = { ...fields };
  if (fields.status !== task.status) Object.assign(patch, statusPatch(task, fields.status));
  // Pushing a due date later counts as postponing it.
  if (task.due_date && fields.due_date && fields.due_date > task.due_date) {
    patch.postpone_count = (task.postpone_count ?? 0) + 1;
  }
  return updateTask(editingId, patch);
}

function openSnooze(task) {
  snoozingId = task.id;
  $('#snooze-task').textContent = task.title;
  $('#unsnooze').hidden = !isSnoozed(task, new Date());
  const now = new Date();
  for (const btn of document.querySelectorAll('#snooze-dialog [data-snooze]')) {
    const kind = btn.dataset.snooze;
    btn.innerHTML = `${SNOOZE_OPTIONS[kind]} <span class="muted small">${esc(formatWhen(snoozeUntil(kind, now).toISOString(), now))}</span>`;
  }
  $('#snooze-dialog').showModal();
}

function applySnooze(kind) {
  const task = findTask(snoozingId);
  if (!task) return;
  if (kind === 'wake') {
    updateTask(task.id, { snoozed_until: null });
    return;
  }
  const until = snoozeUntil(kind, new Date());
  updateTask(task.id, {
    snoozed_until: until.toISOString(),
    postpone_count: (task.postpone_count ?? 0) + 1,
  }).then((saved) => saved && toast(`Snoozed until ${formatWhen(saved.snoozed_until)}`, {
    action: { label: 'Undo', run: () => updateTask(task.id, { snoozed_until: task.snoozed_until, postpone_count: task.postpone_count }) },
  }));
}

// ---------- views & events ----------

function showView(name) {
  $('#auth-view').hidden = name !== 'auth';
  $('#main-view').hidden = name !== 'main';
  $('#sign-out').hidden = name !== 'main' || isDemo;
  $('#user-email').textContent = name === 'main' ? (state.user?.email ?? '') : '';
}

function handleAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.closest('[data-id]')?.dataset.id;
  const task = id ? findTask(id) : null;
  const action = el.dataset.action;
  if (id && (!task || isPending(task))) {
    e.preventDefault();
    return;
  }

  switch (action) {
    case 'start': return updateTask(id, statusPatch(task, 'IN_PROGRESS'));
    case 'pause': return updateTask(id, statusPatch(task, 'TODO'));
    case 'done': return completeTask(task);
    case 'toggle-done': return task.status === 'DONE' ? updateTask(id, statusPatch(task, 'TODO')) : completeTask(task);
    case 'snooze': return openSnooze(task);
    case 'pin': return updateTask(id, { pinned: !task.pinned });
    case 'edit': return openEditor(task);
    case 'reschedule': return openEditor(task, { focus: 'due_date' });
    case 'retry': return loadTasks();
    default: return undefined;
  }
}

function wireEvents() {
  document.addEventListener('click', handleAction);

  $('#quick-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#quick-title');
    const title = input.value.trim();
    if (!title) return input.focus();
    input.value = '';
    createTask({ title: title.slice(0, 200), category: state.filter !== 'all' ? state.filter : 'other' });
  });
  $('#open-add').addEventListener('click', () => {
    const title = $('#quick-title').value.trim();
    $('#quick-title').value = '';
    openEditor(null, { title });
  });
  $('#new-task').addEventListener('click', () => openEditor());

  $('#filter').addEventListener('change', (e) => {
    state.filter = e.target.value;
    render();
  });
  $('#resort').addEventListener('click', applySuggestedOrder);

  const form = $('#task-form');
  form.addEventListener('submit', saveTaskForm);
  form.elements.due_date.addEventListener('input', updateAutoPriorityLabel);
  form.elements.status.addEventListener('change', updateAutoPriorityLabel);
  $('#cancel-task').addEventListener('click', () => $('#task-dialog').close());
  $('#delete-task').addEventListener('click', () => {
    const task = findTask(editingId);
    if (task && confirm(`Delete “${task.title}”? This can’t be undone.`)) {
      $('#task-dialog').close();
      deleteTask(task.id);
    }
  });

  $('#snooze-dialog').addEventListener('close', (e) => {
    const kind = e.target.returnValue;
    e.target.returnValue = '';
    if (kind && kind !== 'cancel') applySnooze(kind);
  });

  enableDragSort($('#task-list'), {
    onMove: (id, { keyboard } = {}) => {
      moveTask(id);
      if (keyboard) document.querySelector(`#task-list [data-id="${id}"] .drag-handle`)?.focus();
    },
    onDragEnd: () => { if (renderPending) render(); },
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = e.target.elements.email.value.trim();
    const msg = $('#auth-msg');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    msg.textContent = 'Sending…';
    try {
      await auth.sendMagicLink(email);
      msg.textContent = `Check ${email} for a sign-in link. You can close this tab.`;
    } catch (err) {
      msg.textContent = `Couldn’t send the link: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
  $('#sign-out').addEventListener('click', async () => {
    try {
      await auth.signOut();
    } catch (err) {
      toast(`Couldn’t sign out: ${err.message}`, { type: 'error' });
    }
  });
  $('#reset-demo')?.addEventListener('click', () => {
    if (!confirm('Reset demo data to the sample tasks?')) return;
    resetDemoData();
    loadTasks();
  });

  // Keep "overdue", "due today" and snooze expiry current while the tab stays open,
  // and pick up changes made on another device when you come back to it.
  setInterval(() => { if (!document.hidden && state.user) render(); }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.user) loadTasks({ quiet: true });
  });
}

async function boot() {
  wireEvents();
  $('#today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#demo-banner').hidden = !isDemo;
  try {
    await auth.onChange((user) => {
      const previousId = state.user?.id;
      state.user = user;
      if (!user) {
        state.tasks = [];
        showView('auth');
        return;
      }
      showView('main');
      // Defer: Supabase advises against awaiting its calls inside this callback.
      if (user.id !== previousId) setTimeout(loadTasks, 0);
    });
  } catch (e) {
    state.loadError = `Couldn’t connect: ${e.message}`;
    state.loading = false;
    showView('main');
    render();
  }
}

boot();
