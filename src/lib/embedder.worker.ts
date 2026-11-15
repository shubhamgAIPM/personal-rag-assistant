// Runs chunking + embedding off the main thread so the UI stays responsive.
// Model files are downloaded from Hugging Face on first use and cached by the browser.
import { AutoTokenizer, env, pipeline } from "@huggingface/transformers";
import { chunkText, embeddingText } from "./chunker.ts";
import { MODEL_DTYPE, MODEL_ID, MODEL_REVISION, QUERY_PREFIX } from "./embeddingConfig.ts";

env.allowLocalModels = false;

export type WorkerRequest =
  | { type: "embedDocument"; id: number; text: string }
  | { type: "embedQuery"; id: number; text: string };

export type WorkerResponse =
  | { type: "progress"; id: number; stage: "loading-model" | "chunking" | "embedding"; done: number; total: number }
  | { type: "documentResult"; id: number; chunks: { index: number; content: string; locator: string | null; tokens: number; embedding: number[] }[] }
  | { type: "queryResult"; id: number; embedding: number[] }
  | { type: "error"; id: number; message: string };

const BATCH_SIZE = 8;

let ready: Promise<{
  extractor: Awaited<ReturnType<typeof pipeline>>;
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
}> | null = null;

function load() {
  ready ??= (async () => {
    const [extractor, tokenizer] = await Promise.all([
      pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE, revision: MODEL_REVISION }),
      AutoTokenizer.from_pretrained(MODEL_ID, { revision: MODEL_REVISION }),
    ]);
    return { extractor, tokenizer };
  })().catch((e) => {
    ready = null; // allow retry after a failed download
    throw e;
  });
  return ready;
}

async function embed(
  extractor: Awaited<ReturnType<typeof pipeline>>,
  texts: string[],
): Promise<number[][]> {
  // pooling "cls" + normalize matches bge-small's training setup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (extractor as any)(texts, { pooling: "cls", normalize: true });
  return out.tolist() as number[][];
}

const post = (msg: WorkerResponse) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    post({ type: "progress", id: req.id, stage: "loading-model", done: 0, total: 1 });
    const { extractor, tokenizer } = await load();
    post({ type: "progress", id: req.id, stage: "loading-model", done: 1, total: 1 });

    if (req.type === "embedQuery") {
      const [embedding] = await embed(extractor, [QUERY_PREFIX + req.text]);
      post({ type: "queryResult", id: req.id, embedding });
      return;
    }

    post({ type: "progress", id: req.id, stage: "chunking", done: 0, total: 1 });
    const count = (t: string) => tokenizer.encode(t, { add_special_tokens: false }).length;
    const chunks = chunkText(req.text, count);
    post({ type: "progress", id: req.id, stage: "chunking", done: 1, total: 1 });

    const results: { index: number; content: string; locator: string | null; tokens: number; embedding: number[] }[] = [];
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      // Documents are embedded WITHOUT the query prefix, but WITH their section path (see embeddingText).
      const vectors = await embed(extractor, batch.map((c) => embeddingText(c)));
      batch.forEach((c, j) => results.push({ ...c, embedding: vectors[j] }));
      post({ type: "progress", id: req.id, stage: "embedding", done: Math.min(i + BATCH_SIZE, chunks.length), total: chunks.length });
    }
    post({ type: "documentResult", id: req.id, chunks: results });
  } catch (e) {
    console.error("embedder worker error", e);
    post({ type: "error", id: req.id, message: "Embedding failed. Check your connection and try again." });
  }
};
