-- Rollback for 0001_init.sql. DESTRUCTIVE: drops these tables and all their data.
-- Run only on your dev project, and only if you want to remove the RAG schema.
-- Does NOT drop the vector extension, since other projects may use it.

drop function if exists public.match_rag_chunks (vector, integer, double precision);
drop table if exists public.rag_chunks;
drop table if exists public.rag_documents;
