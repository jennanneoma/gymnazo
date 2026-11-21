/* Gymnazo database setup.
   How to use: open your Supabase project → SQL Editor → New query → paste this whole file → Run.
   It's safe to run again later (it only adds what's missing and refreshes the rules).

   The idea, in plain words:
   - coaches   : one row per person who uses Coach mode
   - clients   : one row per person's training (their routine, workouts, check-ins, chat).
                 An invite is a client row with nobody's account on it yet (user_id is empty).
   - templates : routines a coach saved to reuse
   - exercises : exercises people added themselves
   - photos    : progress photos, kept apart so the main training row stays small
   Each row keeps its details in "data" (JSON), which is the same shape the app already uses.
   "version" goes up by one on every save, so two phones can't quietly overwrite each other.

   Who can see what (Row Level Security):
   - you see your own rows
   - a coach sees and edits their clients' training
   - a client sees their coach's profile and the coach's own exercises
   - nobody else sees anything */

create table if not exists public.coaches (
  id         text primary key,
  user_id    uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  version    int  not null default 0,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.clients (
  id          text primary key,
  user_id     uuid references auth.users(id) on delete cascade,          -- empty while it's an invite
  coach_id    text references public.coaches(id) on delete set null,     -- empty when training on your own
  status      text not null default 'active' check (status in ('active','invited')),
  invite_code text unique,
  version     int  not null default 0,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  check (user_id is not null or status = 'invited')                      -- only invites have no owner
);
create index if not exists clients_user_idx  on public.clients(user_id);
create index if not exists clients_coach_idx on public.clients(coach_id);

create table if not exists public.templates (
  id         text primary key,
  coach_id   text not null references public.coaches(id) on delete cascade,
  version    int  not null default 0,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists templates_coach_idx on public.templates(coach_id);

create table if not exists public.exercises (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  version    int  not null default 0,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists exercises_user_idx on public.exercises(user_id);

create table if not exists public.photos (
  id         text primary key,
  client_id  text not null references public.clients(id) on delete cascade,
  version    int  not null default 0,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists photos_client_idx on public.photos(client_id);


/* ---------- little helpers the rules below use ----------
   They run with full access ("security definer") so the rules don't loop into each other,
   but each one only ever returns things about the person who's asking (auth.uid()). */

-- my Coach mode row(s)
create or replace function public.my_coach_ids() returns setof text
language sql stable security definer set search_path = public as
$$ select id from coaches where user_id = auth.uid() $$;

-- my own training row(s)
create or replace function public.my_own_client_ids() returns setof text
language sql stable security definer set search_path = public as
$$ select id from clients where user_id = auth.uid() $$;

-- training rows I can open: mine, plus my clients'
create or replace function public.my_client_ids() returns setof text
language sql stable security definer set search_path = public as
$$ select id from clients
   where user_id = auth.uid()
      or coach_id in (select id from coaches where user_id = auth.uid()) $$;

-- the coach(es) I train with
create or replace function public.my_coaches() returns setof text
language sql stable security definer set search_path = public as
$$ select coach_id from clients where user_id = auth.uid() and coach_id is not null $$;

-- the accounts behind the coach(es) I train with (so I can see the exercises they made)
create or replace function public.my_coach_users() returns setof uuid
language sql stable security definer set search_path = public as
$$ select co.user_id from clients c join coaches co on co.id = c.coach_id where c.user_id = auth.uid() $$;


/* ---------- the rules ---------- */
alter table public.coaches   enable row level security;
alter table public.clients   enable row level security;
alter table public.templates enable row level security;
alter table public.exercises enable row level security;
alter table public.photos    enable row level security;

-- coaches: your own row, plus the profile of the coach you train with
drop policy if exists coaches_read   on public.coaches;
drop policy if exists coaches_add    on public.coaches;
drop policy if exists coaches_change on public.coaches;
drop policy if exists coaches_remove on public.coaches;
create policy coaches_read   on public.coaches for select to authenticated using (user_id = auth.uid() or id in (select public.my_coaches()));
create policy coaches_add    on public.coaches for insert to authenticated with check (user_id = auth.uid());
create policy coaches_change on public.coaches for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy coaches_remove on public.coaches for delete to authenticated using (user_id = auth.uid());

-- clients: your own training, or the training of people you coach
drop policy if exists clients_read   on public.clients;
drop policy if exists clients_add    on public.clients;
drop policy if exists clients_change on public.clients;
drop policy if exists clients_remove on public.clients;
create policy clients_read on public.clients for select to authenticated
  using (user_id = auth.uid() or coach_id in (select public.my_coach_ids()));
create policy clients_add on public.clients for insert to authenticated
  with check (
    (user_id = auth.uid() and (coach_id is null or coach_id in (select public.my_coach_ids())))   -- my own training
    or (user_id is null and status = 'invited' and coach_id in (select public.my_coach_ids()))    -- an invite I'm sending
  );
create policy clients_change on public.clients for update to authenticated
  using      (user_id = auth.uid() or coach_id in (select public.my_coach_ids()))
  with check (user_id = auth.uid() or coach_id in (select public.my_coach_ids()));
-- you can delete your own training, and a coach can delete an invite nobody has accepted yet.
-- A coach can't delete someone's real history: they "release" them instead (see release_client below).
create policy clients_remove on public.clients for delete to authenticated
  using (user_id = auth.uid() or (user_id is null and coach_id in (select public.my_coach_ids())));

-- templates: only the coach who made them
drop policy if exists templates_all on public.templates;
create policy templates_all on public.templates for all to authenticated
  using (coach_id in (select public.my_coach_ids())) with check (coach_id in (select public.my_coach_ids()));

-- exercises: yours to change; your coach's are readable so their routines show properly
drop policy if exists exercises_read   on public.exercises;
drop policy if exists exercises_add    on public.exercises;
drop policy if exists exercises_change on public.exercises;
drop policy if exists exercises_remove on public.exercises;
create policy exercises_read   on public.exercises for select to authenticated using (user_id = auth.uid() or user_id in (select public.my_coach_users()));
create policy exercises_add    on public.exercises for insert to authenticated with check (user_id = auth.uid());
create policy exercises_change on public.exercises for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy exercises_remove on public.exercises for delete to authenticated using (user_id = auth.uid());

-- photos: your coach can look, only you can add or remove
drop policy if exists photos_read   on public.photos;
drop policy if exists photos_add    on public.photos;
drop policy if exists photos_change on public.photos;
drop policy if exists photos_remove on public.photos;
create policy photos_read   on public.photos for select to authenticated using (client_id in (select public.my_client_ids()));
create policy photos_add    on public.photos for insert to authenticated with check (client_id in (select public.my_own_client_ids()));
create policy photos_change on public.photos for update to authenticated using (client_id in (select public.my_own_client_ids())) with check (client_id in (select public.my_own_client_ids()));
create policy photos_remove on public.photos for delete to authenticated using (client_id in (select public.my_own_client_ids()));


/* ---------- guard rails on training rows ----------
   The rules above say WHO can edit a row. This says WHAT they can't change:
   - nobody can move a row onto someone else's account
   - you can't attach yourself to a coach without their invite code
   - an invite only turns "active" through join_with_code below */
create or replace function public.clients_guard() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if coalesce(current_setting('gymnazo.trusted', true), '') = '1' then return new; end if;  -- set only by our own functions below
  if auth.uid() is null then return new; end if;                                            -- the Supabase dashboard itself
  if new.user_id is distinct from old.user_id then raise exception 'You can''t move training to another account.'; end if;
  if new.status is distinct from old.status then raise exception 'Invites are accepted with the code.'; end if;
  if new.coach_id is distinct from old.coach_id and new.coach_id is not null
     and new.coach_id not in (select public.my_coach_ids()) then
    raise exception 'Join a coach with their invite code.';
  end if;
  return new;
end $$;
drop trigger if exists clients_guard on public.clients;
create trigger clients_guard before update on public.clients for each row execute function public.clients_guard();

-- keep updated_at fresh on the other tables too
create or replace function public.touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists coaches_touch   on public.coaches;   create trigger coaches_touch   before update on public.coaches   for each row execute function public.touch();
drop trigger if exists templates_touch on public.templates; create trigger templates_touch before update on public.templates for each row execute function public.touch();
drop trigger if exists exercises_touch on public.exercises; create trigger exercises_touch before update on public.exercises for each row execute function public.touch();
drop trigger if exists photos_touch    on public.photos;    create trigger photos_touch    before update on public.photos    for each row execute function public.touch();


/* ---------- invites ---------- */

-- the welcome screen checks a code before the person has an account. It only says which coach it's from.
create or replace function public.invite_info(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('coach', coalesce(nullif(co.data->>'business',''), co.data->>'name'))
  from clients c join coaches co on co.id = c.coach_id
  where c.invite_code = upper(trim(p_code)) and c.status = 'invited' and c.user_id is null
$$;

/* Accept an invite.
   - brand new person (p_my_id empty): the invite becomes their training row
   - someone already training on their own (p_my_id = their row): their row joins the coach, keeping all
     their history, and the invite is used up. The app then moves the coach's routine across.
   Returns the invite's details and the coach's profile, or {ok:false, why:...}. */
create or replace function public.join_with_code(p_code text, p_my_id text default null) returns json
language plpgsql security definer set search_path = public as $$
declare inv clients; co coaches;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'why', 'signin'); end if;
  select * into inv from clients
    where invite_code = upper(trim(p_code)) and status = 'invited' and user_id is null for update;
  if not found then return json_build_object('ok', false, 'why', 'nocode'); end if;
  select * into co from coaches where id = inv.coach_id;
  if co.user_id = auth.uid() then return json_build_object('ok', false, 'why', 'own'); end if;

  perform set_config('gymnazo.trusted', '1', true);   -- lets the guard rail above allow this one change
  if p_my_id is null then
    update clients set user_id = auth.uid(), status = 'active', invite_code = null, version = version + 1,
      data = data || jsonb_build_object('status', 'active', 'inviteCode', null)
      where id = inv.id;
  else
    update clients set coach_id = inv.coach_id, version = version + 1,
      data = data || jsonb_build_object('coachId', inv.coach_id, 'solo', false)
      where id = p_my_id and user_id = auth.uid();
    if not found then perform set_config('gymnazo.trusted', '', true); return json_build_object('ok', false, 'why', 'notyou'); end if;
    delete from clients where id = inv.id;
  end if;
  perform set_config('gymnazo.trusted', '', true);
  return json_build_object('ok', true, 'invite', inv.data, 'invite_id', inv.id, 'coach_id', co.id, 'coach', co.data);
end $$;

-- a coach removing someone who has an account: they keep their history and carry on training on their own
create or replace function public.release_client(p_id text) returns json
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform set_config('gymnazo.trusted', '1', true);
  update clients set coach_id = null, version = version + 1,
    data = data || jsonb_build_object('coachId', null, 'solo', true, 'archived', false)
    where id = p_id and user_id is not null and coach_id in (select id from coaches where user_id = auth.uid());
  get diagnostics n = row_count;
  perform set_config('gymnazo.trusted', '', true);
  return json_build_object('ok', n > 0);
end $$;


/* ---------- who may call what ---------- */
grant usage on schema public to anon, authenticated;
revoke all on public.coaches, public.clients, public.templates, public.exercises, public.photos from anon;
grant select, insert, update, delete on public.coaches, public.clients, public.templates, public.exercises, public.photos to authenticated;
revoke execute on function public.invite_info(text), public.join_with_code(text, text), public.release_client(text) from public;
grant execute on function public.invite_info(text) to anon, authenticated;
grant execute on function public.join_with_code(text, text), public.release_client(text) to authenticated;

-- live updates (chat, a coach seeing a workout land). Skipped quietly where it isn't available.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.clients;   exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.coaches;   exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.templates; exception when duplicate_object then null; end;
  end if;
end $$;
