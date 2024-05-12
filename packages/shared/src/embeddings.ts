import { setImmediate as yieldToIo } from 'node:timers/promises';
import { config } from './config.js';

const dimensions = 384;
const model = 'Xenova/all-MiniLM-L6-v2';
const modelRevision = 'cb3d680149bf9a3209564e1b27ab3bb355b65707';
const openAiModel = 'text-embedding-3-small';
const batchSize = 8;
const cacheLimit = 20_000;
const cache = new Map<string, Promise<number[]>>();

export const embeddingModel = config.embeddingProvider === 'openai'
  ? `openai/${openAiModel}/${dimensions}`
  : `${model}@${modelRevision}`;

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: true }
) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<Extractor> | undefined;
let localQueue = Promise.resolve();

function localExtractor(): Promise<Extractor> {
  extractor ??= import('@xenova/transformers').then(async ({ env, pipeline }) => {
    if (config.embeddingCacheDir) {
      env.cacheDir = config.embeddingCacheDir;
    }
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
    }
    return pipeline('feature-extraction', model, {
      revision: modelRevision,
      quantized: true,
      local_files_only: process.env.EMBEDDING_LOCAL_FILES_ONLY === 'true',
    }) as Promise<Extractor>;
  }).catch((error: unknown) => {
    extractor = undefined;
    throw error;
  });
  return extractor;
}

async function embedWithOpenAi(text: string[]): Promise<number[][]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openAiModel,
      input: text,
      dimensions,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`embedding request returned HTTP ${response.status}`);
  }
  const body = await response.json() as {
    data: { index: number; embedding: number[] }[];
  };
  return body.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

async function embedChunk(text: string[]): Promise<number[][]> {
  if (config.embeddingProvider === 'openai') {
    return embedWithOpenAi(text);
  }
  const call = localQueue.then(async () => {
    // The WASM backend can finish its CPU work without yielding to Kafka's timers.
    await yieldToIo();
    const run = await localExtractor();
    const result = await run(text, { pooling: 'mean', normalize: true });
    return result.tolist();
  });
  localQueue = call.then(() => undefined, () => undefined);
  return call;
}

export async function embedMany(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    signal?.throwIfAborted();
    const chunk = texts.slice(offset, offset + batchSize);
    const missing = [...new Set(chunk.filter((text) => !cache.has(text)))];
    if (missing.length > 0) {
      const result = embedChunk(missing).then((values) => {
        if (values.length !== missing.length ||
          values.some((vector) => vector.length !== dimensions || vector.some((n) => !Number.isFinite(n)))) {
          throw new Error(`expected ${missing.length} embeddings of ${dimensions} dimensions`);
        }
        return values;
      });
      missing.forEach((text, index) => {
        const vector = result.then((values) => values[index]);
        cache.set(text, vector);
        void vector.catch(() => {
          if (cache.get(text) === vector) {
            cache.delete(text);
          }
        });
      });
    }
    vectors.push(...await Promise.all(chunk.map((text) => cache.get(text)!)));
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }
  return vectors;
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedMany([text]);
  return vector;
}
