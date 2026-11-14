-- Rollback for 0002_rate_limit.sql. DESTRUCTIVE: drops the usage counters.
drop function if exists public.rag_consume_quota();
drop table if exists public.rag_usage;
