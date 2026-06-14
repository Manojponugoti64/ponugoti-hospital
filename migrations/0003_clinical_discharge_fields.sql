-- =====================================================================
-- Migration 0003 - Full clinical discharge summary fields
-- Applied 2026-06-12. Additive + nullable; safe to re-run.
-- =====================================================================
alter table public.admissions add column if not exists history_present_illness text;
alter table public.admissions add column if not exists past_history          text;
alter table public.admissions add column if not exists allergies             text;
alter table public.admissions add column if not exists examination_findings  text;
alter table public.admissions add column if not exists course_in_hospital    text;
alter table public.admissions add column if not exists procedures            text;
alter table public.admissions add column if not exists diet_activity_advice  text;
alter table public.admissions add column if not exists follow_up_date        date;
alter table public.admissions add column if not exists warning_signs         text;

-- Structured discharge medications: JSON array of objects shaped like
-- { drug, strength, dose, route, frequency, duration, instructions }
alter table public.admissions add column if not exists discharge_medications jsonb not null default '[]'::jsonb;
