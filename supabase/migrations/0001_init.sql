-- Personal RAG Assistant: schema, RLS and retrieval function.
-- DRAFT: apply to a non-production Supabase project first and run the
-- two-user isolation test before relying on it.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------- tables
create table public.rag_documents (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid references auth.users (id) on delete cascade,
  visibility    text not null check (visibility in ('public_demo', 'private')),
  source_type   text not null check (source_type in ('upload', 'github')),
  title         text not null check (char_length(title) between 1 and 300),
  file_path     text,
  source_url    text,
  content_hash  text,
  status        text not null default 'pending'
                check (status in ('pending', 'processing', 'ready', 'failed')),
  error_message text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- private rows must have an owner; public demo rows must not
  constraint rag_documents_owner_matches_visibility check (
    (visibility = 'private' and owner_id is not null) or
    (visibility = 'public_demo' and owner_id is null)
  )
);

create table public.rag_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.rag_documents (id) on delete cascade,
  owner_id        uuid references auth.users (id) on delete cascade,
  visibility      text not null check (visibility in ('public_demo', 'private')),
  chunk_index     integer not null check (chunk_index >= 0),
  content         text not null,
  embedding       vector(384) not null,
  embedding_model text not null,
  source_locator  text,
  created_at      timestamptz not null default now(),
  constraint rag_chunks_owner_matches_visibility check (
    (visibility = 'private' and owner_id is not null) or
    (visibility = 'public_demo' and owner_id is null)
  )
);

create index rag_chunks_document_id_idx on public.rag_chunks (document_id);
create index rag_chunks_owner_id_idx on public.rag_chunks (owner_id);
-- No vector index yet: the corpus is small. Add HNSW later if needed.

-- ------------------------------------------------------------------- RLS
alter table public.rag_documents enable row level security;
alter table public.rag_chunks    enable row level security;

-- documents: read public demo rows (anyone) or own private rows
create policy rag_documents_select on public.rag_documents
  for select to anon, authenticated
  using (
    visibility = 'public_demo'
    or (visibility = 'private' and owner_id = (select auth.uid()))
  );

-- documents: clients may only write their own private rows.
-- public_demo rows are written only via the service role (seed script).
create policy rag_documents_insert on public.rag_documents
  for insert to authenticated
  with check (visibility = 'private' and owner_id = (select auth.uid()));

create policy rag_documents_update on public.rag_documents
  for update to authenticated
  using (visibility = 'private' and owner_id = (select auth.uid()))
  with check (visibility = 'private' and owner_id = (select auth.uid()));

create policy rag_documents_delete on public.rag_documents
  for delete to authenticated
  using (visibility = 'private' and owner_id = (select auth.uid()));

-- chunks: same rules. Insert also requires the parent document to be the
-- caller's own, so a user cannot attach chunks to someone else's document.
create policy rag_chunks_select on public.rag_chunks
  for select to anon, authenticated
  using (
    visibility = 'public_demo'
    or (visibility = 'private' and owner_id = (select auth.uid()))
  );

create policy rag_chunks_insert on public.rag_chunks
  for insert to authenticated
  with check (
    visibility = 'private'
    and owner_id = (select auth.uid())
    and exists (
      select 1 from public.rag_documents d
      where d.id = document_id
        and d.owner_id = (select auth.uid())
        and d.visibility = 'private'
    )
  );

create policy rag_chunks_delete on public.rag_chunks
  for delete to authenticated
  using (visibility = 'private' and owner_id = (select auth.uid()));

-- ------------------------------------------------------------- retrieval
-- SECURITY INVOKER (the default, stated explicitly): RLS applies as the
-- calling user, so only permitted chunks can ever be returned.
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
