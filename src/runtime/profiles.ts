export type InferenceProfileName = 'performance' | 'large-context' | 'balanced' | 'custom';

export interface LlamaRuntimeConfig {
  profileName: InferenceProfileName;
  modelPath: string;
  modelAlias: string;
  serverPath?: string;
  host: string;
  port: number;
  autoPort: boolean;
  autoStart: boolean;
  contextSize: number;
  nCpuMoe: number;
  nGpuLayers: number; // -ngl (e.g. 999)
  batchSize: number;  // -b 2048
  ubatchSize: number; // -ub 512
  flashAttention: boolean; // --flash-attn on
  cacheTypeK: 'turbo4' | 'turbo3' | 'turbo2' | 'f16' | 'q8_0' | 'q4_0';
  cacheTypeV: 'turbo4' | 'turbo3' | 'turbo2' | 'f16' | 'q8_0' | 'q4_0';
  noMmap: boolean;    // --no-mmap
  mlock: boolean;     // --mlock
  threads: number;    // -t 12
  jinja: boolean;     // --jinja
}

export const DEFAULT_QWEN_MODEL_PATH =
  'C:\\Users\\aksha\\.cache\\huggingface\\hub\\models--HauhauCS--Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive\\snapshots\\f12a584fecbeb5f20001130d8ecd66c9327ae685\\Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ2_M.gguf';

export const DEFAULT_QWEN_MODEL_ALIAS = 'locode-qwen35b-a3b';

export const INFERENCE_PROFILES: Record<InferenceProfileName, Partial<LlamaRuntimeConfig>> = {
  performance: {
    profileName: 'performance',
    contextSize: 32768,
    nCpuMoe: 24,
    nGpuLayers: 999,
    batchSize: 2048,
    ubatchSize: 512,
    flashAttention: true,
    cacheTypeK: 'turbo4',
    cacheTypeV: 'turbo4',
    noMmap: true,
    mlock: true,
    threads: 12,
    jinja: true
  },
  'large-context': {
    profileName: 'large-context',
    contextSize: 65536,
    nCpuMoe: 24,
    nGpuLayers: 999,
    batchSize: 2048,
    ubatchSize: 512,
    flashAttention: true,
    cacheTypeK: 'turbo4',
    cacheTypeV: 'turbo4',
    noMmap: true,
    mlock: true,
    threads: 12,
    jinja: true
  },
  balanced: {
    profileName: 'balanced',
    contextSize: 16384,
    nCpuMoe: 28,
    nGpuLayers: 999,
    batchSize: 1024,
    ubatchSize: 256,
    flashAttention: true,
    cacheTypeK: 'turbo4',
    cacheTypeV: 'turbo4',
    noMmap: false,
    mlock: false,
    threads: 8,
    jinja: true
  },
  custom: {
    profileName: 'custom'
  }
};
