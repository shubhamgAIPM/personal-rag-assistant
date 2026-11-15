// Shared embedding configuration. Changing the model, revision or dtype means
// every stored chunk must be re-embedded, and the pgvector column dimension
// (vector(384)) must match EMBEDDING_DIM exactly.
export const MODEL_ID = "Xenova/bge-small-en-v1.5";
// Pinned commit of the model repo (checked 2025-07 listing; verify before upgrading).
export const MODEL_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
export const MODEL_DTYPE = "q8" as const;
export const EMBEDDING_DIM = 384;
// How chunk text is prepared before embedding. Bump this if the preparation changes, because
// stored vectors made a different way are not comparable and must be re-embedded.
//   ctx1 = section path + "\n\n" + chunk text (see embeddingText in chunker.ts)
export const EMBEDDING_INPUT_FORMAT = "ctx1";
// Stored per chunk so a model or preparation mismatch is detectable later.
export const EMBEDDING_MODEL_LABEL = `${MODEL_ID}@${MODEL_REVISION.slice(0, 8)}:${MODEL_DTYPE}+${EMBEDDING_INPUT_FORMAT}`;

// bge-small has a 512-token input limit including [CLS] and [SEP].
export const MODEL_MAX_TOKENS = 512;
export const SPECIAL_TOKENS = 2;

// bge asks for this prefix on search queries only (not on documents).
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
