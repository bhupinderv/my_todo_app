-- Next — V1 schema. Paste into Supabase → SQL Editor → Run. Safe to re-run.
--
-- One table. Future tables (task_events, user_preferences,
-- recommendation_log, ...) can reference tasks(id) without changing it.

create table if not exists public.tasks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,

  title              text not null check (char_length(btrim(title)) between 1 and 200),
  category           text not null default 'other',          -- work, cooking, household, study, errands, other
  notes              text,
  due_date           date,                                    -- date only, no time
  effort_minutes     integer check (effort_minutes > 0),

  status             text not null default 'TODO'
                     check (status in ('TODO', 'IN_PROGRESS', 'DONE')),
  user_priority      text check (user_priority in ('HIGH', 'MEDIUM', 'LOW')),       -- null = let the app decide
  suggested_priority text check (suggested_priority in ('HIGH', 'MEDIUM', 'LOW')),  -- app's latest opinion

  position           double precision not null default 0,     -- manual order (fractional, so a move updates one row)
  pinned             boolean not null default false,          -- user forced into Top 3
  snoozed_until      timestamptz,                             -- hidden from recommendations until then
  postpone_count     integer not null default 0 check (postpone_count >= 0),

  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists tasks_user_position_idx on public.tasks (user_id, position);

-- Keep updated_at current.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- Row-level security: each signed-in user sees and changes only their own rows.
-- This is what makes it safe to ship the anon key in a public GitHub Pages site.
alter table public.tasks enable row level security;

revoke all on public.tasks from anon;
grant select, insert, update, delete on public.tasks to authenticated;

drop policy if exists "tasks: read own" on public.tasks;
create policy "tasks: read own" on public.tasks
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "tasks: insert own" on public.tasks;
create policy "tasks: insert own" on public.tasks
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "tasks: update own" on public.tasks;
create policy "tasks: update own" on public.tasks
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "tasks: delete own" on public.tasks;
create policy "tasks: delete own" on public.tasks
  for delete to authenticated using (user_id = (select auth.uid()));
