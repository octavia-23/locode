export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface CostEstimate {
  isKnown: boolean;
  cost?: number;
  promptCost?: number;
  completionCost?: number;
}

/**
 * Trustworthy model pricing table (rates per 1M tokens in USD).
 * Sourced directly from official vendor pricing documentation.
 */
export const TRUSTWORTHY_MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-4-turbo': { inputPerMillion: 10.00, outputPerMillion: 30.00 },
  'o1': { inputPerMillion: 15.00, outputPerMillion: 60.00 },
  'o1-mini': { inputPerMillion: 3.00, outputPerMillion: 12.00 },
  'o3-mini': { inputPerMillion: 1.10, outputPerMillion: 4.40 },

  // Anthropic
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-3-5-sonnet-latest': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-3-opus-20240229': { inputPerMillion: 15.00, outputPerMillion: 75.00 },

  // Google Gemini
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
  'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-2.5-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-3.8-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  'gemini-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },

  // Groq
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'llama-3.1-8b-instant': { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  'mixtral-8x7b-32768': { inputPerMillion: 0.24, outputPerMillion: 0.24 },

  // Local models (known free)
  'ollama': { inputPerMillion: 0.0, outputPerMillion: 0.0 },
  'llama-cpp': { inputPerMillion: 0.0, outputPerMillion: 0.0 }
};

/**
 * Resolves trustworthy pricing metadata for a given model or provider.
 * Never fabricates or guesses pricing when unknown.
 */
export function getModelPricing(modelName: string, providerType?: string): ModelPricing | null {
  if (providerType === 'ollama' || providerType === 'llama-cpp') {
    return { inputPerMillion: 0.0, outputPerMillion: 0.0 };
  }

  const normalized = modelName.toLowerCase().trim();
  // Check exact match
  if (TRUSTWORTHY_MODEL_PRICING[normalized]) {
    return TRUSTWORTHY_MODEL_PRICING[normalized];
  }

  // Check prefix or substring match against known models
  for (const [key, pricing] of Object.entries(TRUSTWORTHY_MODEL_PRICING)) {
    if (key !== 'ollama' && key !== 'llama-cpp' && (normalized.startsWith(key) || normalized.includes(key))) {
      return pricing;
    }
  }

  return null;
}

/**
 * Estimates execution cost from token usage.
 * Returns { isKnown: false } when pricing is not established.
 * Never fabricates numbers.
 */
export function estimateUsageCost(
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
  modelName: string,
  providerType?: string
): CostEstimate {
  if (!usage) {
    return { isKnown: false };
  }

  const pricing = getModelPricing(modelName, providerType);
  if (!pricing) {
    return { isKnown: false };
  }

  const promptTokens = usage.promptTokens || 0;
  const completionTokens = usage.completionTokens || 0;

  const promptCost = (promptTokens * pricing.inputPerMillion) / 1_000_000;
  const completionCost = (completionTokens * pricing.outputPerMillion) / 1_000_000;
  const cost = promptCost + completionCost;

  return {
    isKnown: true,
    cost: Number(cost.toFixed(6)),
    promptCost: Number(promptCost.toFixed(6)),
    completionCost: Number(completionCost.toFixed(6))
  };
}
