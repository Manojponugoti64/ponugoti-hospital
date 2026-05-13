-- =====================================================================
-- Ponugoti Hospital - Database schema + Row-Level Security
-- Paste this whole file into the Supabase SQL Editor and click "Run".
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS.
-- =====================================================================

-- ---------- 1. Extensions ----------
create extension if not exists "pgcrypto";

-- ---------- 2. Roles enum ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'staff_role') then
    create type staff_role as enum ('admin','doctor','nurse','lab','reception');
  end if;
end$$;

-- ---------- 3. Profiles (extends auth.users) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role staff_role not null default 'reception',
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user is added.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    coalesce((new.raw_user_meta_data->>'role')::staff_role, 'reception')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Helper to read the current user's role (used in RLS policies).
create or replace function public.current_role_name()
returns staff_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ---------- 4. Patients ----------
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  mrn text unique not null,
  full_name text not null,
  dob date,
  sex text check (sex in ('M','F','Other')),
  phone text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

-- ---------- 5. Admissions ----------
create table if not exists public.admissions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  admission_date timestamptz not null default now(),
  discharge_date timestamptz,
  ward text,
  bed text,
  admitting_doctor text,
  chief_complaints text,
  provisional_diagnosis text,
  final_diagnosis text,
  treatment_given text,
  condition_at_discharge text,
  follow_up text,
  medications text,
  discharge_summary text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create index if not exists admissions_patient_idx on public.admissions(patient_id);
create index if not exists admissions_admission_date_idx on public.admissions(admission_date desc);

-- ---------- 6. Investigations (lab results) ----------
create table if not exists public.investigations (
  id uuid primary key default gen_random_uuid(),
  admission_id uuid not null references public.admissions(id) on delete cascade,
  test_name text not null,
  test_value text,
  units text,
  normal_range text,
  comments text,
  performed_at timestamptz not null default now(),
  performed_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists investigations_admission_idx on public.investigations(admission_id);

-- ---------- 7. Auto-update updated_at ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_patients_touch on public.patients;
create trigger trg_patients_touch before update on public.patients
for each row execute function public.touch_updated_at();

drop trigger if exists trg_admissions_touch on public.admissions;
create trigger trg_admissions_touch before update on public.admissions
for each row execute function public.touch_updated_at();

-- ---------- 8. Enable RLS ----------
alter table public.profiles       enable row level security;
alter table public.patients       enable row level security;
alter table public.admissions     enable row level security;
alter table public.investigations enable row level security;

-- ---------- 9. Policies ----------
-- All authenticated staff can read everything.
drop policy if exists "read profiles for staff"       on public.profiles;
drop policy if exists "read patients for staff"       on public.patients;
drop policy if exists "read admissions for staff"     on public.admissions;
drop policy if exists "read investigations for staff" on public.investigations;

create policy "read profiles for staff"
  on public.profiles for select to authenticated using (true);
create policy "read patients for staff"
  on public.patients for select to authenticated using (true);
create policy "read admissions for staff"
  on public.admissions for select to authenticated using (true);
create policy "read investigations for staff"
  on public.investigations for select to authenticated using (true);

-- Profiles: a user can update their own full_name; only admins change roles.
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid() or current_role_name() = 'admin')
  with check (id = auth.uid() or current_role_name() = 'admin');

-- Patients: reception/doctor/nurse/admin can insert + update; admin can delete.
drop policy if exists "insert patients" on public.patients;
drop policy if exists "update patients" on public.patients;
drop policy if exists "delete patients" on public.patients;

create policy "insert patients"
  on public.patients for insert to authenticated
  with check (current_role_name() in ('admin','doctor','nurse','reception'));

create policy "update patients"
  on public.patients for update to authenticated
  using  (current_role_name() in ('admin','doctor','nurse','reception'))
  with check (current_role_name() in ('admin','doctor','nurse','reception'));

create policy "delete patients"
  on public.patients for delete to authenticated
  using (current_role_name() = 'admin');

-- Admissions: reception/doctor/nurse/admin can insert + update; admin delete.
drop policy if exists "insert admissions" on public.admissions;
drop policy if exists "update admissions" on public.admissions;
drop policy if exists "delete admissions" on public.admissions;

create policy "insert admissions"
  on public.admissions for insert to authenticated
  with check (current_role_name() in ('admin','doctor','nurse','reception'));

create policy "update admissions"
  on public.admissions for update to authenticated
  using  (current_role_name() in ('admin','doctor','nurse','reception'))
  with check (current_role_name() in ('admin','doctor','nurse','reception'));

create policy "delete admissions"
  on public.admissions for delete to authenticated
  using (current_role_name() = 'admin');

-- Investigations: lab/doctor/nurse/admin can insert+update; admin delete.
drop policy if exists "insert investigations" on public.investigations;
drop policy if exists "update investigations" on public.investigations;
drop policy if exists "delete investigations" on public.investigations;

create policy "insert investigations"
  on public.investigations for insert to authenticated
  with check (current_role_name() in ('admin','doctor','nurse','lab'));

create policy "update investigations"
  on public.investigations for update to authenticated
  using  (current_role_name() in ('admin','doctor','nurse','lab'))
  with check (current_role_name() in ('admin','doctor','nurse','lab'));

create policy "delete investigations"
  on public.investigations for delete to authenticated
  using (current_role_name() in ('admin','lab'));

-- =====================================================================
-- DONE. Next steps in Supabase Dashboard:
--   1. Authentication → Users → "Add user" (one per staff member)
--      Provide email + password; users will log in with these.
--   2. After each new user is created, run e.g.:
--        update public.profiles
--           set full_name = 'Dr. Manoj Kumar', role = 'admin'
--         where id = (select id from auth.users where email = 'you@example.com');
--      Roles: 'admin' | 'doctor' | 'nurse' | 'lab' | 'reception'
-- =====================================================================
