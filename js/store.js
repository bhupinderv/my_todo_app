// Data access. The UI only talks to `tasksApi` and `auth`, so the backend can
// be swapped: Supabase when configured, localStorage in demo mode.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { todayISO, addDays } from './dates.js';

export const isDemo = !SUPABASE_URL || !SUPABASE_ANON_KEY;

const COLUMNS = [
  'id', 'title', 'category', 'due_date', 'user_priority', 'suggested_priority',
  'status', 'effort_minutes', 'notes', 'pinned', 'position', 'snoozed_until',
  'postpone_count', 'started_at', 'completed_at', 'created_at', 'updated_at',
].join(',');

// ---------- Supabase ----------

let clientPromise = null;
function getClient() {
  clientPromise ??= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
  return clientPromise;
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

const remoteTasks = {
  async list() {
    const db = await getClient();
    return unwrap(await db.from('tasks').select(COLUMNS).order('position'));
  },
  async create(fields) {
    const db = await getClient();
    return unwrap(await db.from('tasks').insert(fields).select(COLUMNS).single());
  },
  async update(id, patch) {
    const db = await getClient();
    return unwrap(await db.from('tasks').update(patch).eq('id', id).select(COLUMNS).single());
  },
  async remove(id) {
    const db = await getClient();
    unwrap(await db.from('tasks').delete().eq('id', id));
  },
};

const remoteAuth = {
  async signInWithPassword(email, password) {
    const db = await getClient();
    unwrap(await db.auth.signInWithPassword({ email, password }));
  },
  async sendMagicLink(email) {
    const db = await getClient();
    unwrap(await db.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    }));
  },
  async signOut() {
    const db = await getClient();
    unwrap(await db.auth.signOut());
  },
  /** Calls `callback(user | null)` now and whenever the session changes. */
  async onChange(callback) {
    const db = await getClient();
    db.auth.onAuthStateChange((_event, session) => callback(session?.user ?? null));
  },
};

// ---------- Demo mode (localStorage) ----------

const STORAGE_KEY = 'next.demo.tasks.v1';

const DEFAULTS = {
  category: 'other', due_date: null, user_priority: null, suggested_priority: null,
  status: 'TODO', effort_minutes: null, notes: null, pinned: false, position: 0,
  snoozed_until: null, postpone_count: 0, started_at: null, completed_at: null,
};

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeLocal(tasks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    throw new Error('Could not save to browser storage.');
  }
}

function demoSeed() {
  const today = todayISO();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const rows = [
    { title: 'Finish API implementation', category: 'work', due_date: addDays(today, -1), user_priority: 'HIGH', status: 'IN_PROGRESS', effort_minutes: 120, started_at: iso(2 * 3_600_000) },
    { title: 'Prepare presentation', category: 'work', due_date: today, user_priority: 'HIGH', effort_minutes: 60 },
    { title: 'Buy groceries', category: 'errands', due_date: today, effort_minutes: 30 },
    { title: 'Renew library books', category: 'errands', due_date: addDays(today, -3), effort_minutes: 15 },
    { title: 'Meal prep for the week', category: 'cooking', due_date: addDays(today, 2), effort_minutes: 90 },
    { title: 'Study: chapter 4', category: 'study', due_date: addDays(today, 5), effort_minutes: 60, notes: 'Focus on graph algorithms.' },
    { title: 'Clean the kitchen', category: 'household', user_priority: 'LOW', effort_minutes: 30, postpone_count: 2 },
    { title: 'Reply to landlord', category: 'errands', status: 'DONE', completed_at: iso(20 * 3_600_000) },
  ];
  return rows.map((r, i) => ({
    ...DEFAULTS, ...r,
    id: crypto.randomUUID(), position: (i + 1) * 1000,
    created_at: iso(86_400_000), updated_at: iso(86_400_000),
  }));
}

const localTasks = {
  async list() {
    let tasks = readLocal();
    if (!tasks) writeLocal((tasks = demoSeed()));
    return tasks.sort((a, b) => a.position - b.position);
  },
  async create(fields) {
    const now = new Date().toISOString();
    const task = { ...DEFAULTS, ...fields, id: crypto.randomUUID(), created_at: now, updated_at: now };
    writeLocal([...(readLocal() ?? []), task]);
    return task;
  },
  async update(id, patch) {
    const tasks = readLocal() ?? [];
    const i = tasks.findIndex((t) => t.id === id);
    if (i === -1) throw new Error('Task not found.');
    tasks[i] = { ...tasks[i], ...patch, updated_at: new Date().toISOString() };
    writeLocal(tasks);
    return tasks[i];
  },
  async remove(id) {
    writeLocal((readLocal() ?? []).filter((t) => t.id !== id));
  },
};

const demoAuth = {
  async signInWithPassword() {},
  async sendMagicLink() {},
  async signOut() {},
  async onChange(callback) {
    callback({ id: 'demo', email: 'Demo mode' });
  },
};

export const tasksApi = isDemo ? localTasks : remoteTasks;
export const auth = isDemo ? demoAuth : remoteAuth;

export function resetDemoData() {
  localStorage.removeItem(STORAGE_KEY);
}
