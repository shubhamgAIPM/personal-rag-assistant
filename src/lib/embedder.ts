// Main-thread client for the embedding worker.
import type { WorkerRequest, WorkerResponse } from "./embedder.worker.ts";

export interface EmbeddedChunk {
  index: number;
  content: string;
  locator: string | null;
  tokens: number;
  embedding: number[];
}

export type EmbedStage = "loading-model" | "chunking" | "embedding";
export type ProgressHandler = (stage: EmbedStage, done: number, total: number) => void;

type Pending = {
  onProgress?: ProgressHandler;
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./embedder.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === "progress") {
      p.onProgress?.(msg.stage, msg.done, msg.total);
      return;
    }
    pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  };
  w.onerror = () => {
    for (const p of pending.values()) p.reject(new Error("Embedding worker crashed."));
    pending.clear();
    worker = null;
  };
  worker = w;
  return w;
}

function request(req: Omit<WorkerRequest, "id">, onProgress?: ProgressHandler): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { onProgress, resolve, reject });
    getWorker().postMessage({ ...req, id } as WorkerRequest);
  });
}

export async function embedDocument(text: string, onProgress?: ProgressHandler): Promise<EmbeddedChunk[]> {
  const res = await request({ type: "embedDocument", text }, onProgress);
  if (res.type !== "documentResult") throw new Error("Unexpected worker response.");
  return res.chunks;
}

export async function embedQuery(text: string, onProgress?: ProgressHandler): Promise<number[]> {
  const res = await request({ type: "embedQuery", text }, onProgress);
  if (res.type !== "queryResult") throw new Error("Unexpected worker response.");
  return res.embedding;
}
