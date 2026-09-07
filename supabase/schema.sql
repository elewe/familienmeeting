-- Familienmeeting — Supabase-Schema (Projekt "Familienmeeting" in der
-- Organisation "Familie in Verbindung"). Zur Referenz und für ein neues
-- Projekt (z. B. Staging) — bereits live per Migrationen angewendet auf
-- rwmofgrcermtalmgexsp.

-- Haushalte
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Familie',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Mitgliedschaft: per E-Mail eingeladen, user_id wird beim ersten Login nachgetragen
create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  email text not null,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_at timestamptz not null default now(),
  primary key (household_id, email)
);
create index household_members_user_id_idx on public.household_members(user_id);
create index household_members_email_idx on public.household_members(lower(email));

-- Die App-Daten (dieselbe Struktur wie das bisherige localStorage `state`)
create table public.household_data (
  household_id uuid primary key references public.households(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Helper-Funktionen (SECURITY DEFINER, um rekursive RLS auf household_members zu vermeiden)
create or replace function public.is_household_member(target_household_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = target_household_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_household_owner(target_household_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = target_household_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

-- Beim ersten Login: falls die E-Mail schon eingeladen wurde, user_id nachtragen
create or replace function public.handle_new_user_household_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.household_members
  set user_id = new.id
  where user_id is null
    and lower(email) = lower(new.email);
  return new;
end;
$$;

create trigger on_auth_user_created_link_household
  after insert on auth.users
  for each row execute function public.handle_new_user_household_link();

-- Deckt den Fall ab, dass jemand eingeladen wird, nachdem er sich schon einmal
-- eingeloggt hatte (der obige Trigger feuert nur beim allerersten Login).
-- Sicher: kann nur user_id auf die eigene, per JWT verifizierte E-Mail setzen.
create or replace function public.claim_pending_household_invites()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.household_members
  set user_id = auth.uid()
  where user_id is null
    and lower(email) = lower(auth.jwt() ->> 'email');
end;
$$;

-- RLS
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_data enable row level security;

create policy "households_select_members" on public.households
  for select using (public.is_household_member(id));

create policy "households_insert_authenticated" on public.households
  for insert with check (auth.uid() is not null and created_by = auth.uid());

create policy "members_select_same_household" on public.household_members
  for select using (public.is_household_member(household_id));

create policy "members_insert_owner_or_self_claim" on public.household_members
  for insert with check (
    public.is_household_owner(household_id)
    or (
      user_id = auth.uid()
      and role = 'owner'
      and not exists (select 1 from public.household_members m2 where m2.household_id = household_id)
    )
  );

create policy "members_delete_owner" on public.household_members
  for delete using (public.is_household_owner(household_id));

create policy "data_select_members" on public.household_data
  for select using (public.is_household_member(household_id));

create policy "data_insert_members" on public.household_data
  for insert with check (public.is_household_member(household_id));

create policy "data_update_members" on public.household_data
  for update using (public.is_household_member(household_id));

-- Grants: Postgres grantet EXECUTE auf neue Funktionen standardmäßig an PUBLIC.
-- Das explizit einschränken, damit nur die nötigen Rollen die Helper aufrufen können.
revoke execute on function public.is_household_member(uuid) from public;
revoke execute on function public.is_household_owner(uuid) from public;
revoke execute on function public.handle_new_user_household_link() from public;
revoke execute on function public.claim_pending_household_invites() from public;

grant execute on function public.is_household_member(uuid) to anon, authenticated;
grant execute on function public.is_household_owner(uuid) to anon, authenticated;
grant execute on function public.claim_pending_household_invites() to authenticated;
-- handle_new_user_household_link() bleibt ohne Grants: wird nur vom Trigger ausgelöst.
