import { FunctionsHttpError } from "@supabase/supabase-js";
import { embedQuery } from "./embedder.ts";
import { supabase } from "./supabase.ts";

export interface Source {
  ref: string;
  chunk_id: string;
  document_id: string;
  title: string;
  locator: string | null;
  excerpt: string;
  similarity: number;
}

export interface Answer {
  answer: string;
  insufficient_evidence: boolean;
  sources: Source[];
}

export type AskStage = "embedding" | "searching";

/** An error whose message is safe to show to the user. */
export class AskError extends Error {}

const GENERIC = "Something went wrong while answering. Please try again.";

function isAnswer(x: unknown): x is Answer {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.answer === "string" && typeof o.insufficient_evidence === "boolean" && Array.isArray(o.sources);
}

export async function askQuestion(question: string, onStage?: (stage: AskStage) => void): Promise<Answer> {
  onStage?.("embedding");
  let embedding: number[];
  try {
    embedding = await embedQuery(question);
  } catch {
    throw new AskError("Could not prepare your question. Check your connection and try again.");
  }

  onStage?.("searching");
  const { data, error } = await supabase.functions.invoke("answer-question", {
    body: { question, query_embedding: embedding },
  });

  if (error) {
    if (error instanceof FunctionsHttpError) {
      // The function returns { error: "<safe message>" } for expected failures.
      try {
        const body = await error.context.json();
        if (typeof body?.error === "string") throw new AskError(body.error);
      } catch (e) {
        if (e instanceof AskError) throw e;
      }
    }
    throw new AskError(GENERIC);
  }
  if (!isAnswer(data)) throw new AskError(GENERIC);
  return data;
}
