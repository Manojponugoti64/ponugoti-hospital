-- =====================================================================
-- Migration 0004 - Outpatient (OP) visit clinical records
-- Applied 2026-06-12. Additive + nullable; safe to re-run.
-- =====================================================================
-- Structured prescription for OP visits (same shape as
-- admissions.discharge_medications: array of drug objects).
alter table public.op_visits add column if not exists prescription_meds jsonb not null default '[]'::jsonb;

-- Optional examination / vitals note for OP visits.
alter table public.op_visits add column if not exists examination_findings text;

-- Correlate an OP bill back to the OP visit it was raised for.
alter table public.bills add column if not exists op_visit_id uuid references public.op_visits(id) on delete set null;
create index if not exists bills_op_visit_idx on public.bills(op_visit_id);
