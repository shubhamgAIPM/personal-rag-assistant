-- Rate limiting for the answer-question Edge Function.
-- DRAFT: apply to the non-production project first.
--
-- Protects the shared Groq free-tier quota: per-user per-minute and per-day
-- limits, plus a global daily cap. Limits are constants INSIDE the function, not
-- parameters, so a client calling the RPC directly cannot inflate them or push
-- the global counter.

create table public.rag_usage (
  user_id    uuid not null,
  bucket     text not null,
  count      integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, bucket)
);

-- RLS on with NO policies: clients can neither read nor write this table.
alter table public.rag_usage enable row level security;
revoke all on public.rag_usage from anon, authenticated;

create or replace function public.rag_consume_quota()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Tune these here (and re-apply) if the Groq plan limits change.
  per_minute      constant integer := 8;
  per_day         constant integer := 100;
  global_per_day  constant integer := 800;

  uid             uuid := auth.uid();
  global_uid      constant uuid := '00000000-0000-0000-0000-000000000000';
  minute_bucket   text := 'm:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI');
  day_bucket      text := 'd:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  m integer;
  d integer;
  g integer;
begin
  if uid is null then
    return false;
  end if;

  -- Opportunistic cleanup of old buckets.
  delete from public.rag_usage where created_at < now() - interval '2 days';

  insert into public.rag_usage (user_id, bucket, count)
  values (uid, minute_bucket, 1)
  on conflict (user_id, bucket) do update set count = public.rag_usage.count + 1
  returning count into m;

  insert into public.rag_usage (user_id, bucket, count)
  values (uid, day_bucket, 1)
  on conflict (user_id, bucket) do update set count = public.rag_usage.count + 1
  returning count into d;

  if m > per_minute or d > per_day then
    return false; -- user over their own limit; do not touch the global counter
  end if;

  insert into public.rag_usage (user_id, bucket, count)
  values (global_uid, day_bucket, 1)
  on conflict (user_id, bucket) do update set count = public.rag_usage.count + 1
  returning count into g;

  return g <= global_per_day;
end;
$$;

revoke all on function public.rag_consume_quota() from public, anon;
grant execute on function public.rag_consume_quota() to authenticated;
