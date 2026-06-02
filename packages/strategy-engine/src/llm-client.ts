// ============================================================
// Multi-Provider LLM Client
//
// Priority order:
//   1. OpenRouter   — broadest routing surface and free router support
//   2. Gemini       — official Google OpenAI-compatible endpoint
//   3. Mistral      — solid instruction-following fallback
//   4. NVIDIA NIM   — reliable open-model fallback
//   5. OpenCode Zen — OpenAI-compatible fallback for supported chat models
//
// All configured providers below expose OpenAI-compatible chat APIs.
//
// "Planning" role = heavier reasoning (strategy generation)
// "Parsing" role  = faster JSON extraction (intent parsing)
// ============================================================

import OpenAI from "openai";
import type { ClientOptions } from "openai";

// ─── Provider configs ─────────────────────────────────────────────────────────
const PROVIDERS = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    // google/gemini-2.5-flash-lite: confirmed 200 on OpenRouter, good JSON output
    planningModel: "google/gemini-2.5-flash-lite",
    parsingModel: "google/gemini-2.5-flash-lite",
    displayName: "OpenRouter",
    headers: {
      "HTTP-Referer": "https://defi-composer.xyz",
      "X-Title": "DeFi Composer",
    },
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    // gemini-2.5-flash: confirmed 200 on direct Gemini endpoint
    planningModel: "gemini-2.5-flash",
    parsingModel: "gemini-2.5-flash",
    displayName: "Google Gemini",
    headers: {},
  },
  mistral: {
    baseURL: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    planningModel: "mistral-small-latest",
    parsingModel: "mistral-small-latest",
    displayName: "Mistral",
    headers: {},
  },
  nvidia: {
    baseURL: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    planningModel: "meta/llama-3.3-70b-instruct",
    parsingModel: "meta/llama-3.1-8b-instruct",
    displayName: "NVIDIA NIM",
    headers: {},
  },
  opencode: {
    baseURL: "https://opencode.ai/zen/v1",
    envKey: "OPENCODE_API_KEY",
    planningModel: "nemotron-3-super-free",
    parsingModel: "nemotron-3-super-free",
    displayName: "OpenCode Zen",
    headers: {},
  },
} as const;

// Keys that still have placeholder values should be skipped
function isValidKey(key: string): boolean {
  return key.length > 10 && !key.startsWith("your_") && !key.includes("_here");
}

export type LLMRole = "planning" | "parsing";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  text: string;
  model: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface ProviderTarget {
  provider: string;
  displayName: string;
  model: string;
  client: OpenAI;
}

// ─── Unified client ───────────────────────────────────────────────────────────
export class LLMClient {
  private targets: ProviderTarget[];
  private activeIndex: number;

  private constructor(
    targets: ProviderTarget[]
  ) {
    this.targets = targets;
    this.activeIndex = 0;
  }

  get model(): string {
    return this.targets[this.activeIndex]?.model ?? "";
  }

  get provider(): string {
    return this.targets[this.activeIndex]?.provider ?? "";
  }

  get displayName(): string {
    return this.targets[this.activeIndex]?.displayName ?? "";
  }

  async complete(
    messages: LLMMessage[],
    opts: {
      maxTokens?: number;
      validate?: (text: string) => void;
    } = {}
  ): Promise<LLMResponse> {
    const failures: string[] = [];

    for (let attempt = 0; attempt < this.targets.length; attempt++) {
      const idx = (this.activeIndex + attempt) % this.targets.length;
      const target = this.targets[idx]!;

      try {
        const response = await target.client.chat.completions.create({
          model: target.model,
          messages,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: 0.3,
        });

        const text = response.choices[0]?.message?.content ?? "";
        if (!text) {
          throw new Error(
            `[LLM] Empty response from ${target.displayName} (model: ${target.model})`
          );
        }
        opts.validate?.(text);

        this.activeIndex = idx;

        return {
          text,
          model: target.model,
          provider: target.provider,
          ...(response.usage?.prompt_tokens !== undefined && {
            inputTokens: response.usage.prompt_tokens,
          }),
          ...(response.usage?.completion_tokens !== undefined && {
            outputTokens: response.usage.completion_tokens,
          }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${target.displayName} (${target.model}): ${message}`);

        if (attempt < this.targets.length - 1) {
          console.warn(
            `[LLM] ${target.displayName} failed, trying next provider: ${message}`
          );
        }
      }
    }

    throw new Error(`[LLM] All providers failed. ${failures.join(" | ")}`);
  }

  private static buildTarget(
    provider: string,
    apiKey: string,
    baseURL: string,
    model: string,
    displayName: string,
    extraHeaders: Record<string, string>
  ): ProviderTarget {
    const options: ClientOptions = {
      apiKey,
      baseURL,
      defaultHeaders: extraHeaders,
    };

    return {
      provider,
      displayName,
      model,
      client: new OpenAI(options),
    };
  }

  // Factory — collect all available keys in priority order
  static create(role: LLMRole): LLMClient {
    const targets: ProviderTarget[] = [];

    for (const [providerKey, config] of Object.entries(PROVIDERS)) {
      const apiKey = process.env[config.envKey];
      if (!apiKey || !isValidKey(apiKey)) continue;

      const model =
        role === "planning" ? config.planningModel : config.parsingModel;

      targets.push(
        LLMClient.buildTarget(
          providerKey,
          apiKey,
          config.baseURL,
          model,
          config.displayName,
          config.headers as Record<string, string>
        )
      );
    }

    if (targets.length > 0) {
      console.log(
        `[LLM] Configured ${role} providers: ${targets
          .map((t) => `${t.displayName} (${t.model})`)
          .join(" -> ")}`
      );
      return new LLMClient(targets);
    }

    throw new Error(
      `[LLM] No API key found. Set one of: ${Object.values(PROVIDERS)
        .map((p) => p.envKey)
        .join(", ")}`
    );
  }
}
