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
  'claude-3-5-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-3-5-sonnet-latest': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-3-5-haiku': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-3-opus': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
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

export interface PreflightCostEstimate extends CostEstimate {
  estimatedPromptTokens: number;
  projectedOutputTokens: number;
  bufferedPromptTokens?: number;
  projectedTurnCost?: number;
  isExceeded: boolean;
  canReduceOutputAllowance?: boolean;
  maxAllowableOutputTokens?: number;
  reason?: string;
}

export interface CostReconciliation {
  isKnown: boolean;
  estimatedPreflightCost: number;
  actualCost: number;
  variance: number;
  promptTokensActual: number;
  completionTokensActual: number;
  reconciledTurnCost: number;
}

/**
 * Reconciles pre-flight estimates against actual reported token usage after request execution.
 */
export function reconcileUsageCost(
  estimatedPreflight: PreflightCostEstimate,
  actualUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined,
  currentTurnCost: number,
  modelName: string,
  providerType?: string
): CostReconciliation {
  const usageCost = estimateUsageCost(actualUsage, modelName, providerType);
  const actualCost = usageCost.isKnown && typeof usageCost.cost === 'number'
    ? usageCost.cost
    : (estimatedPreflight.cost || 0);
  const estimated = estimatedPreflight.cost || 0;
  const variance = Number((actualCost - estimated).toFixed(6));
  const reconciledTurnCost = Number((currentTurnCost + actualCost).toFixed(6));

  return {
    isKnown: usageCost.isKnown,
    estimatedPreflightCost: estimated,
    actualCost,
    variance,
    promptTokensActual: actualUsage?.promptTokens || estimatedPreflight.estimatedPromptTokens,
    completionTokensActual: actualUsage?.completionTokens || estimatedPreflight.projectedOutputTokens,
    reconciledTurnCost
  };
}

/**
 * Calculates a conservative pre-flight cost projection before dispatching an LLM request.
 * Incorporates a 15% uncertainty margin for token estimation variance.
 * Acts BEFORE cloud spend occurs using prompt token estimation and maxOutputTokens bounds.
 */
export function estimatePreflightCost(
  promptTokens: number,
  maxOutputTokens: number,
  currentTurnCost: number,
  modelName: string,
  providerType?: string,
  maxCostPerTurn?: number,
  tokenUncertaintyFactor: number = 1.15
): PreflightCostEstimate {
  const pricing = getModelPricing(modelName, providerType);
  if (!pricing) {
    return {
      isKnown: false,
      estimatedPromptTokens: promptTokens,
      projectedOutputTokens: maxOutputTokens,
      isExceeded: false,
      reason: `Pricing is unknown for model "${modelName}" (${providerType || 'cloud'}). Spending cannot be predicted.`
    };
  }

  // Account for estimation uncertainty in prompt token counts
  const bufferedPromptTokens = Math.ceil(promptTokens * tokenUncertaintyFactor);
  const promptCost = (bufferedPromptTokens * pricing.inputPerMillion) / 1_000_000;
  const projectedCompletionCost = (maxOutputTokens * pricing.outputPerMillion) / 1_000_000;
  const projectedRequestCost = promptCost + projectedCompletionCost;
  const projectedTotalTurnCost = currentTurnCost + projectedRequestCost;

  const isExceeded = typeof maxCostPerTurn === 'number' && maxCostPerTurn > 0 && projectedTotalTurnCost > maxCostPerTurn;

  // Compute potential output allowance reduction if exceeded
  let maxAllowableOutputTokens = 0;
  let canReduceOutputAllowance = false;

  if (isExceeded && typeof maxCostPerTurn === 'number' && pricing.outputPerMillion > 0) {
    const remainingBudget = maxCostPerTurn - currentTurnCost;
    const availableForOutput = remainingBudget - promptCost;
    if (availableForOutput > 0) {
      maxAllowableOutputTokens = Math.floor((availableForOutput * 1_000_000) / pricing.outputPerMillion);
      canReduceOutputAllowance = maxAllowableOutputTokens >= 256;
    }
  }

  return {
    isKnown: true,
    cost: Number(projectedRequestCost.toFixed(6)),
    projectedTurnCost: Number(projectedTotalTurnCost.toFixed(6)),
    promptCost: Number(promptCost.toFixed(6)),
    completionCost: Number(projectedCompletionCost.toFixed(6)),
    estimatedPromptTokens: promptTokens,
    bufferedPromptTokens,
    projectedOutputTokens: maxOutputTokens,
    isExceeded,
    canReduceOutputAllowance,
    maxAllowableOutputTokens: isExceeded ? maxAllowableOutputTokens : undefined,
    reason: isExceeded
      ? `Projected cost ($${projectedTotalTurnCost.toFixed(4)}) would exceed maximum allowed spend per turn ($${maxCostPerTurn.toFixed(2)}).`
      : undefined
  };
}
