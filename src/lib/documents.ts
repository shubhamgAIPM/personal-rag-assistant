import { supabase } from "./supabase.ts";

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface DocumentRow {
  id: string;
  title: string;
  source_type: "upload" | "github";
  visibility: "public_demo" | "private";
  status: DocumentStatus;
  error_message: string | null;
  created_at: string;
}

export async function listDocuments(): Promise<DocumentRow[]> {
  const { data, error } = await supabase
    .from("rag_documents")
    .select("id,title,source_type,visibility,status,error_message,created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not load your documents.");
  return data as DocumentRow[];
}

export async function deleteDocument(id: string): Promise<void> {
  // Chunks are removed by ON DELETE CASCADE.
  const { error } = await supabase.from("rag_documents").delete().eq("id", id);
  if (error) throw new Error("Could not delete the document.");
}
