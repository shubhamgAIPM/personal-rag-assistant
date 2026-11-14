// Feasibility check: load the embedding model and confirm dimension + token limit.
import { pipeline, AutoTokenizer } from "@huggingface/transformers";

const MODEL = "Xenova/bge-small-en-v1.5";

const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
const out = await extractor("Hello world", { pooling: "cls", normalize: true });
console.log("model:", MODEL);
console.log("dimension:", out.dims[out.dims.length - 1]);

const tok = await AutoTokenizer.from_pretrained(MODEL);
console.log("tokenizer model_max_length:", tok.model_max_length);
