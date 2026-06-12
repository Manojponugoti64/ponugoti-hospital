-- =====================================================================
-- Migration 0002 - Security hardening
-- Applied 2026-06-12. Resolves Supabase database-linter security warnings.
-- Safe to re-run.
-- =====================================================================

-- 1. Pin search_path on every function (blocks search_path injection,
--    important for SECURITY DEFINER functions especially).
alter function public.touch_updated_at()                set search_path = public, pg_temp;
alter function public.compute_invoice_item_total()      set search_path = public, pg_temp;
alter function public.invoice_items_totals_changed()    set search_path = public, pg_temp;
alter function public.payments_totals_changed()         set search_path = public, pg_temp;
alter function public.invoice_header_totals_changed()   set search_path = public, pg_temp;
alter function public.handle_new_user()                 set search_path = public, pg_temp;
alter function public.current_role_name()               set search_path = public, pg_temp;
alter function public.recalculate_invoice_totals(uuid)  set search_path = public, pg_temp;

-- 2. Lock down SECURITY DEFINER functions from direct API/RPC calls.
--    handle_new_user runs only as an auth.users trigger.
--    recalculate_invoice_totals runs only via billing triggers.
revoke all on function public.handle_new_user()                from public, anon, authenticated;
revoke all on function public.recalculate_invoice_totals(uuid)  from public, anon, authenticated;

-- 3. current_role_name() is evaluated INSIDE RLS policies, so the
--    'authenticated' role MUST retain EXECUTE. Only strip anon/public.
revoke all    on function public.current_role_name() from public, anon;
grant  execute on function public.current_role_name() to authenticated;
