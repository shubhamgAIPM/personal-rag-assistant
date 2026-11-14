-- Rate limiting for the PUBLIC DEMO (visitors who are not signed in).
-- DRAFT: apply to the non-production project first.
--
-- Visitors are identified by a keyed hash of their IP address (computed in the
-- Edge Function; the raw IP is never stored). Limits are constants inside the
-- function. Only the service role may call it, so clients cannot call it
-- directly to inflate counters or burn the global demo cap.

create or replace function public.rag_consume_demo_quota(client_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Tune here (and re-apply) to match the Groq plan's limits.
  per_minute      constant integer := 5;
  per_day         constant integer := 40;
  global_per_day  constant integer := 300;

  demo_uid        constant uuid := '00000000-0000-0000-0000-000000000001';
  minute_stamp    text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI');
  day_stamp       text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  m integer;
  d integer;
  g integer;
begin
  if client_hash is null or client_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  delete from public.rag_usage where created_at < now() - interval '2 days';

  insert into public.rag_usage (user_id, bucket, count)
  values (demo_uid, 'c:' || client_hash || ':m:' || minute_stamp, 1)
  on conflict (user_id, bucket) do update set count = public.rag_usage.count + 1
  returning count into m;

  insert into public.rag_usage (user_id, bucket, count)
  values (demo_uid, 'c:' || client_hash || ':d:' || day_stamp, 1)
  on conflict (user_id, bucket) do update set count = public.rag_usage.count + 1
  returning count into d;

  if m > per_minute or d > per_day then
    return false; -- this visitor is over their own limit; leave the global cap alone
  end if;

  insert into public.rag_usage (user_id, bucket, count)
  values (demo_uid, 'g:d:' || day_stamp, 1)
  on conflict (user_id, bucket) do update set count = public.rag_usage.count + 1
  returning count into g;

  return g <= global_per_day;
end;
$$;

revoke all on function public.rag_consume_demo_quota(text) from public, anon, authenticated;
grant execute on function public.rag_consume_demo_quota(text) to service_role;
