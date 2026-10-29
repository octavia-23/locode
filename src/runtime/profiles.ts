import os from 'node:os';
import path from 'node:path';
import type { HardwareProfile } from '../hardware/detector.js';

export type InferenceProfileName = 'ultra-context' | 'performance' | 'large-context' | 'balanced' | 'custom';

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
  cacheReuse: number; // --cache-reuse N (min chunk size to reuse from KV cache)
  reasoningFormat?: 'none' | 'deepseek' | 'qwen'; // --reasoning-format none (prevents internal parser mangling of tool tokens)
}

export const DEFAULT_QWEN_MODEL_PATH =
  process.env.LOCODE_MODEL_PATH ||
  path.join(
    os.homedir(),
    '.cache',
    'huggingface',
    'hub',
    'models--HauhauCS--Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf'
  );

export const DEFAULT_QWEN_MODEL_ALIAS = 'locode-qwen35b-a3b';

export const INFERENCE_PROFILES: Record<InferenceProfileName, Partial<LlamaRuntimeConfig>> = {
  'ultra-context': {
    profileName: 'ultra-context',
    contextSize: 262144,
    nCpuMoe: 34,
    nGpuLayers: 999,
    batchSize: 2048,
    ubatchSize: 512,
    flashAttention: true,
    cacheTypeK: 'turbo4',
    cacheTypeV: 'turbo3',
    noMmap: true,
    mlock: true,
    threads: 12,
    jinja: true,
    cacheReuse: 256,
    reasoningFormat: 'none'
  },
  performance: {
    profileName: 'performance',
    contextSize: 32768,
    nCpuMoe: 24,
    nGpuLayers: 999,
    batchSize: 2048,
    ubatchSize: 512,
    flashAttention: true,
    cacheTypeK: 'q4_0',
    cacheTypeV: 'q4_0',
    noMmap: true,
    mlock: true,
    threads: 12,
    jinja: true,
    cacheReuse: 256,
    reasoningFormat: 'none'
  },
  'large-context': {
    profileName: 'large-context',
    contextSize: 131072,
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
    jinja: true,
    cacheReuse: 256,
    reasoningFormat: 'none'
  },
  balanced: {
    profileName: 'balanced',
    contextSize: 65536,
    nCpuMoe: 28,
    nGpuLayers: 999,
    batchSize: 1024,
    ubatchSize: 256,
    flashAttention: true,
    cacheTypeK: 'q8_0',
    cacheTypeV: 'q8_0',
    noMmap: false,
    mlock: false,
    threads: 8,
    jinja: true,
    cacheReuse: 256,
    reasoningFormat: 'none'
  },
  custom: {
    profileName: 'custom'
  }
};

/**
 * Resolves a full runtime configuration given a profile name and optional overrides.
 */
export function resolveProfileConfig(
  profileName: InferenceProfileName = 'balanced',
  overrides?: Partial<LlamaRuntimeConfig>
): LlamaRuntimeConfig {
  const baseProfile = INFERENCE_PROFILES[profileName] || INFERENCE_PROFILES.balanced;
  return {
    profileName,
    modelPath: process.env.LOCODE_LOCAL_MODEL_PATH || DEFAULT_QWEN_MODEL_PATH,
    modelAlias: DEFAULT_QWEN_MODEL_ALIAS,
    serverPath: process.env.LOCODE_LLAMA_SERVER_PATH,
    host: '127.0.0.1',
    port: process.env.LOCODE_LOCAL_MODEL_PORT ? parseInt(process.env.LOCODE_LOCAL_MODEL_PORT, 10) : 8081,
    autoPort: true,
    autoStart: process.env.LOCODE_LOCAL_MODEL_AUTO_START !== 'false',
    contextSize: baseProfile.contextSize || 65536,
    nCpuMoe: baseProfile.nCpuMoe ?? 28,
    nGpuLayers: baseProfile.nGpuLayers ?? 999,
    batchSize: baseProfile.batchSize ?? 1024,
    ubatchSize: baseProfile.ubatchSize ?? 256,
    flashAttention: baseProfile.flashAttention ?? true,
    cacheTypeK: baseProfile.cacheTypeK || 'q8_0',
    cacheTypeV: baseProfile.cacheTypeV || 'q8_0',
    noMmap: baseProfile.noMmap ?? false,
    mlock: baseProfile.mlock ?? false,
    threads: baseProfile.threads ?? 8,
    jinja: baseProfile.jinja ?? true,
    cacheReuse: baseProfile.cacheReuse ?? 256,
    reasoningFormat: baseProfile.reasoningFormat || 'none',
    ...baseProfile,
    ...overrides
  };
}

/**
 * Hardware-adaptive profile mapper:
 * - < 10240 MB effective VRAM/unified RAM -> 'performance' (32768, q4_0 KV)
 * - 10240 MB - 24576 MB effective VRAM/unified RAM -> 'balanced' (65536, q8_0 KV)
 * - 24577 MB - 49152 MB effective VRAM/unified RAM -> 'large-context' (131072, turbo4 KV)
 * - > 49152 MB effective VRAM/unified RAM -> 'ultra-context' (262144, turbo4/turbo3 KV)
 */
export function resolveProfileForHardware(
  profile: HardwareProfile,
  overrides?: Partial<LlamaRuntimeConfig>
): LlamaRuntimeConfig {
  const effectiveMemoryMb = (profile.totalVramMb && profile.totalVramMb > 0)
    ? profile.totalVramMb
    : profile.totalRamMb;
  let selectedProfile: InferenceProfileName;

  if (effectiveMemoryMb < 10240) {
    selectedProfile = 'performance';
  } else if (effectiveMemoryMb <= 24576) {
    selectedProfile = 'balanced';
  } else if (effectiveMemoryMb <= 49152) {
    selectedProfile = 'large-context';
  } else {
    selectedProfile = 'ultra-context';
  }

  return resolveProfileConfig(selectedProfile, overrides);
}

/**
 * Phase 4: Unified Local and Cloud Execution Profiles
 */
export type ProfileMode = 'local' | 'cloud' | 'hybrid';

export interface PrivacyPolicy {
  /**
   * If false, never implicitly transfers the full repository map/context to an external cloud model.
   * Only explicit file mentions (@file) and directly inspected snippets are sent.
   */
  allowFullRepoContext: boolean;
  allowWebAccess: boolean;
  redactSecrets: boolean;
}

export interface CostPolicy {
  maxCostPerTurn?: number;
  alertOnCostThreshold?: boolean;
  requireConfirmationAboveCost?: number;
}

export interface HarnessExecutionProfile {
  name: string;
  mode: ProfileMode;
  safetyCeiling: number;
  maxExplorationReads: number;
  forceMutationAfterReads: boolean;
  allowParallelTools: boolean;
  enableThinking: boolean;
  privacyPolicy: PrivacyPolicy;
  costPolicy: CostPolicy;
  timeoutMs: number;
}

export const LOCAL_CONSERVATIVE_PROFILE: HarnessExecutionProfile = {
  name: 'local-conservative',
  mode: 'local',
  safetyCeiling: 45,
  maxExplorationReads: 2,
  forceMutationAfterReads: true,
  allowParallelTools: false,
  enableThinking: false,
  privacyPolicy: {
    allowFullRepoContext: true, // Safe on local device
    allowWebAccess: true,
    redactSecrets: false
  },
  costPolicy: {},
  timeoutMs: 180000
};

export const LOCAL_TURBO_PROFILE: HarnessExecutionProfile = {
  name: 'local-turbo',
  mode: 'local',
  safetyCeiling: 60,
  maxExplorationReads: 8,
  forceMutationAfterReads: true,
  allowParallelTools: false,
  enableThinking: false,
  privacyPolicy: {
    allowFullRepoContext: true,
    allowWebAccess: true,
    redactSecrets: false
  },
  costPolicy: {},
  timeoutMs: 240000
};

export const CLOUD_FRONTIER_PROFILE: HarnessExecutionProfile = {
  name: 'cloud-frontier',
  mode: 'cloud',
  safetyCeiling: 100,
  maxExplorationReads: 25,
  forceMutationAfterReads: false,
  allowParallelTools: true,
  enableThinking: true,
  privacyPolicy: {
    allowFullRepoContext: false, // Explicit Privacy Guard: Never implicitly upload full repo map to cloud
    allowWebAccess: true,
    redactSecrets: true
  },
  costPolicy: {
    maxCostPerTurn: 2.0,
    alertOnCostThreshold: true
  },
  timeoutMs: 300000
};

export const HYBRID_PROFILE: HarnessExecutionProfile = {
  name: 'hybrid',
  mode: 'hybrid',
  safetyCeiling: 75,
  maxExplorationReads: 6,
  forceMutationAfterReads: true,
  allowParallelTools: false,
  enableThinking: false,
  privacyPolicy: {
    allowFullRepoContext: false,
    allowWebAccess: true,
    redactSecrets: true
  },
  costPolicy: {
    maxCostPerTurn: 1.0,
    alertOnCostThreshold: true
  },
  timeoutMs: 240000
};

export function resolveExecutionProfile(
  isCloud: boolean,
  customProfile?: Partial<HarnessExecutionProfile>,
  privacyOverride?: Partial<PrivacyPolicy>
): HarnessExecutionProfile {
  const base = isCloud ? CLOUD_FRONTIER_PROFILE : LOCAL_CONSERVATIVE_PROFILE;

  return {
    ...base,
    ...customProfile,
    privacyPolicy: {
      ...base.privacyPolicy,
      ...customProfile?.privacyPolicy,
      ...privacyOverride
    },
    costPolicy: {
      ...base.costPolicy,
      ...customProfile?.costPolicy
    }
  };
}
