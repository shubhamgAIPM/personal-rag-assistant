-- Rollback for 0004_match_scope.sql: restore the original 3-argument function from 0001.
drop function if exists public.match_rag_chunks (vector, integer, double precision, text);

create or replace function public.match_rag_chunks (
  query_embedding vector(384),
  match_count     integer default 5,
  min_similarity  double precision default 0.0
)
returns table (
  id             uuid,
  document_id    uuid,
  title          text,
  source_locator text,
  content        text,
  similarity     double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select c.id,
         c.document_id,
         d.title,
         c.source_locator,
         c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.rag_chunks c
  join public.rag_documents d on d.id = c.document_id
  where d.status = 'ready'
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 10);
$$;
