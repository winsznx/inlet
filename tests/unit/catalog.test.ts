import { describe, expect, it } from "vitest";
import { describeModel, estimateCostUsd, selectAgentModel } from "@inlet/agent";
import type { CatalogModel, ModelCapabilities } from "@inlet/agent";

function catalogModel(id: string, options: { tools?: boolean; context?: number; prompt?: string; completion?: string; image?: boolean } = {}): CatalogModel {
  return {
    id,
    input_modalities: [
      {
        type: "text",
        pricing: options.prompt === undefined ? [] : [{ type: "prompt", cost_usd: options.prompt }],
        supported_inputs: { max_context_length: { value: options.context ?? 128_000 } },
      },
      ...(options.image ? [{ type: "image" }] : []),
    ],
    output_modalities: [
      {
        type: "text",
        supported_parameters: options.tools === false ? {} : { tools: {} },
        pricing: options.completion === undefined ? [] : [{ type: "completion", cost_usd: options.completion }],
      },
    ],
  };
}

const describeOrThrow = (model: CatalogModel): ModelCapabilities => {
  const described = describeModel(model);
  if (!described) throw new Error(`${model.id} did not describe`);
  return described;
};

describe("describeModel", () => {
  it("reads capabilities from the catalog shape", () => {
    expect(describeModel(catalogModel("m", { context: 64_000, prompt: "0.000001", completion: "0.000002", image: true }))).toEqual({
      id: "m",
      supportsTools: true,
      supportsImages: true,
      contextTokens: 64_000,
      promptUsdPerToken: 0.000001,
      completionUsdPerToken: 0.000002,
    });
  });

  it("returns null for a model with no text output", () => {
    expect(describeModel({ id: "embed", input_modalities: [{ type: "text" }], output_modalities: [{ type: "embedding" }] })).toBeNull();
    expect(describeModel({ id: "bare" })).toBeNull();
  });

  it("reports a model without tool support", () => {
    expect(describeModel(catalogModel("m", { tools: false }))?.supportsTools).toBe(false);
  });

  it("treats missing or non-numeric pricing as unknown, not free", () => {
    expect(describeModel(catalogModel("m"))?.promptUsdPerToken).toBeNull();
    expect(describeModel(catalogModel("m", { prompt: "free" }))?.promptUsdPerToken).toBeNull();
  });

  it("defaults an unknown context window to zero so it cannot be selected", () => {
    const model = catalogModel("m");
    const text = model.input_modalities?.[0];
    if (text) text.supported_inputs = undefined;
    expect(describeModel(model)?.contextTokens).toBe(0);
  });
});

describe("selectAgentModel", () => {
  const cheap = describeOrThrow(catalogModel("cheap-model", { prompt: "0.0000001", completion: "0.0000002" }));
  const pricey = describeOrThrow(catalogModel("pricey-model", { prompt: "0.00001", completion: "0.00002" }));
  const unpriced = describeOrThrow(catalogModel("unpriced-model"));
  const preferredFirst = describeOrThrow(catalogModel("deepseek-v4.1-flash-1017", { prompt: "0.00005", completion: "0.00005" }));
  const preferredSecond = describeOrThrow(catalogModel("qwen3.8-flash-next", { prompt: "0.00005", completion: "0.00005" }));
  const noTools = describeOrThrow(catalogModel("deepseek-v4.1-flash-1017", { tools: false }));
  const smallContext = describeOrThrow(catalogModel("qwen3.8-flash-next", { context: 16_000 }));

  it("prefers the first preferred model over cheaper ones", () => {
    expect(selectAgentModel([cheap, preferredSecond, preferredFirst])?.id).toBe("deepseek-v4.1-flash-1017");
  });

  it("falls through the preference order", () => {
    expect(selectAgentModel([cheap, preferredSecond])?.id).toBe("qwen3.8-flash-next");
  });

  it("falls back to the cheapest usable model", () => {
    expect(selectAgentModel([pricey, unpriced, cheap])?.id).toBe("cheap-model");
  });

  it("never picks a preferred model that cannot use tools or is too small", () => {
    expect(selectAgentModel([noTools, smallContext, pricey])?.id).toBe("pricey-model");
  });

  it("returns null rather than an unsuitable model", () => {
    expect(selectAgentModel([noTools, smallContext])).toBeNull();
    expect(selectAgentModel([])).toBeNull();
  });

  it("honours a configured model when usable", () => {
    expect(selectAgentModel([cheap, pricey], "pricey-model")?.id).toBe("pricey-model");
  });

  it("does not substitute another model when the configured one is unusable", () => {
    expect(selectAgentModel([cheap, noTools], "deepseek-v4.1-flash-1017")).toBeNull();
    expect(selectAgentModel([cheap], "does-not-exist")).toBeNull();
  });

  it("accepts a model at exactly the minimum context", () => {
    const edge = describeOrThrow(catalogModel("edge", { context: 32_000 }));
    expect(selectAgentModel([edge])?.id).toBe("edge");
  });
});

describe("estimateCostUsd", () => {
  it("multiplies tokens by their prices", () => {
    const model = describeOrThrow(catalogModel("m", { prompt: "0.000001", completion: "0.000002" }));
    expect(estimateCostUsd(model, 1_000, 500)).toBeCloseTo(0.002, 8);
  });

  it("returns null when pricing is unknown instead of reporting zero", () => {
    expect(estimateCostUsd(describeOrThrow(catalogModel("m")), 1_000, 500)).toBeNull();
    expect(estimateCostUsd(null, 1_000, 500)).toBeNull();
  });
});
