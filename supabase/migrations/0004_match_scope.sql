-- Add a scope to match_rag_chunks so the private workspace searches ONLY the
-- caller's own (private) chunks, and the demo searches ONLY public_demo chunks.
-- Without this, signed-in users' private-workspace searches also returned public
-- demo chunks, because RLS lets every signed-in user read public_demo rows.
--
-- DRAFT: apply to the non-production project first.
-- Adding a parameter creates a second overload, which makes 3-argument calls
-- ambiguous, so the old function is dropped and replaced. RLS still applies
-- (security invoker): scope can only narrow what the caller may see, never widen it.

drop function if exists public.match_rag_chunks (vector, integer, double precision);

create or replace function public.match_rag_chunks (
  query_embedding vector(384),
  match_count     integer default 5,
  min_similarity  double precision default 0.0,
  scope           text default 'any'
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
    and scope in ('any', 'private', 'public_demo')
    and (scope = 'any' or c.visibility = scope)
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 10);
$$;
