import { env } from "@inlet/config";

type CatalogPricing = { type?: string; unit?: string; cost_usd?: string };
type CatalogModality = {
  type?: string;
  pricing?: CatalogPricing[];
  supported_parameters?: Record<string, unknown>;
  supported_inputs?: { max_context_length?: { value?: number } };
};
export type CatalogModel = {
  id: string;
  name?: string;
  input_modalities?: CatalogModality[];
  output_modalities?: CatalogModality[];
};

export type ModelCapabilities = {
  id: string;
  supportsTools: boolean;
  supportsImages: boolean;
  contextTokens: number;
  promptUsdPerToken: number | null;
  completionUsdPerToken: number | null;
};

export function describeModel(model: CatalogModel): ModelCapabilities | null {
  const textOutput = model.output_modalities?.find((item) => item.type === "text");
  if (!textOutput) return null;
  const textInput = model.input_modalities?.find((item) => item.type === "text");
  return {
    id: model.id,
    supportsTools: Boolean(textOutput.supported_parameters && "tools" in textOutput.supported_parameters),
    supportsImages: Boolean(model.input_modalities?.some((item) => item.type === "image")),
    contextTokens: textInput?.supported_inputs?.max_context_length?.value ?? 0,
    promptUsdPerToken: Number(textInput?.pricing?.find((item) => item.type === "prompt")?.cost_usd ?? Number.NaN) || null,
    completionUsdPerToken: Number(textOutput.pricing?.find((item) => item.type === "completion")?.cost_usd ?? Number.NaN) || null,
  };
}

export async function fetchCatalog(baseUrl = env().VULTR_INFERENCE_BASE_URL): Promise<ModelCapabilities[]> {
  const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Model catalog returned ${response.status}`);
  const body = (await response.json()) as { data?: CatalogModel[] };
  return (body.data ?? []).map(describeModel).filter((model): model is ModelCapabilities => model !== null);
}

const PREFERRED_MODELS = ["deepseek-v4.1-flash-1017", "qwen3.8-flash-next", "qwen3.8-27b"];

export function selectAgentModel(models: ModelCapabilities[], configured?: string): ModelCapabilities | null {
  const usable = models.filter((model) => model.supportsTools && model.contextTokens >= 32_000);
  if (configured) return usable.find((model) => model.id === configured) ?? null;
  for (const id of PREFERRED_MODELS) {
    const found = usable.find((model) => model.id === id);
    if (found) return found;
  }
  return usable.sort((a, b) => (a.promptUsdPerToken ?? 1) - (b.promptUsdPerToken ?? 1))[0] ?? null;
}

export function estimateCostUsd(model: ModelCapabilities | null, promptTokens: number, completionTokens: number): number | null {
  if (!model?.promptUsdPerToken || !model.completionUsdPerToken) return null;
  return promptTokens * model.promptUsdPerToken + completionTokens * model.completionUsdPerToken;
}
