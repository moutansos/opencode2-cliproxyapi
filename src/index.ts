import { Model, Plugin, Provider } from "@opencode/plugin"
import {
  discoverModelMetadata,
  discoverModels,
  normalizeBaseURL,
  type CatalogModel,
  type ModelMetadata,
  type ModelMetadataCatalog,
} from "./catalog.js"

const DEFAULT_BASE_URL = "http://localhost:8317/v1"
const DEFAULT_PROVIDER_ID = "cliproxyapi"
const DEFAULT_PROVIDER_NAME = "CLIProxyAPI"
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000
const DEFAULT_MODEL_METADATA_URL = "https://models.dev/api.json"
const DEFAULT_REFRESH_MS = 5 * 60_000

const CHAT_PACKAGE = "@opencode/ai/providers/openai-compatible"
const RESPONSES_PACKAGE = "@opencode/ai/providers/openai-compatible/responses"
const MESSAGES_PACKAGE = "@opencode/ai/providers/anthropic"
const ANTHROPIC_NPM = "@ai-sdk/anthropic"
const DEFAULT_ANTHROPIC_EFFORTS = ["low", "medium", "high"] as const

type ConnectorOptions = {
  baseURL?: string
  apiKey?: string
  providerID?: string
  providerName?: string
  protocol?: "chat" | "responses"
  modelMetadataURL?: string | false
  discoveryTimeoutMs?: number
  refreshIntervalMs?: number
}

type Cost = Model.Info["cost"][number]
type Money = Cost["input"]

export default Plugin.define({
  id: "opencode2-cliproxyapi",
  async setup(ctx) {
    if (!ctx.provider) {
      console.warn(
        "[cliproxyapi] this OpenCode server does not expose the provider registry; upgrade to OpenCode 2.0.4 or newer",
      )
      return
    }

    const options = readOptions(ctx.options)
    const providerID = Provider.ID.make(options.providerID ?? DEFAULT_PROVIDER_ID)
    const existing = await ctx.provider.get({ providerID }).catch(() => undefined)
    const existingSettings = (existing?.data.settings ?? {}) as Record<string, unknown>
    const baseURL = normalizeBaseURL(
      options.baseURL ??
        process.env.CLIPROXY_BASE_URL ??
        stringOption(existingSettings.baseURL) ??
        DEFAULT_BASE_URL,
    )
    const apiKey =
      options.apiKey ?? process.env.CLIPROXY_API_KEY ?? stringOption(existingSettings.apiKey)
    const timeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
    const refreshMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS

    const source = {
      info: {
        ...Provider.Info.empty(providerID),
        name: options.providerName ?? DEFAULT_PROVIDER_NAME,
        activation: "enabled" as const,
        package: options.protocol === "responses" ? RESPONSES_PACKAGE : CHAT_PACKAGE,
        settings: {
          baseURL,
          ...(apiKey ? { apiKey } : {}),
        },
      },
      models: [] as Model.Info[],
    }

    const refresh = async (initial: boolean) => {
      const [catalog, metadataDiscovery] = await Promise.all([
        discoverModels({ baseURL, apiKey, timeoutMs }),
        discoverMetadata({
          url: options.modelMetadataURL ?? DEFAULT_MODEL_METADATA_URL,
          timeoutMs,
        }),
      ])

      if (metadataDiscovery.error) console.warn(`[cliproxyapi] ${metadataDiscovery.error}`)

      source.models = catalog.map((model) =>
        buildModel({
          providerID,
          model,
          metadata: metadataDiscovery.catalog,
        }),
      )

      if (!initial) await ctx.provider.reload()
      console.log(`[cliproxyapi] discovered ${source.models.length} models from ${baseURL}`)
    }

    await refresh(true)

    await ctx.provider.transform((editor) => {
      editor.add({ info: source.info, models: source.models })
    })

    await ctx.session.hook(
      "model.request",
      (event) => {
        if (!apiKey) return
        event.headers.authorization ??= `Bearer ${apiKey}`
      },
      { providerID },
    )

    if (refreshMs <= 0) return

    const timer = setInterval(() => {
      void refresh(false).catch((error) => {
        console.warn(
          `[cliproxyapi] catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }, refreshMs)
    timer.unref?.()
    return () => clearInterval(timer)
  },
})

export {
  discoverModelMetadata,
  discoverModels,
  normalizeBaseURL,
  parseCatalog,
  parseModelMetadataCatalog,
} from "./catalog.js"
export type { CatalogModel, ModelMetadata, ModelMetadataCatalog } from "./catalog.js"

export function buildModel(input: {
  providerID: Provider.ID
  model: CatalogModel
  metadata: ModelMetadataCatalog
}): Model.Info {
  const modelID = Model.ID.make(input.model.id)
  const resolved = resolveMetadata(input.metadata, input.model)
  const metadata = resolved.metadata
  const image = isImageModel(input.model.id)
  const anthropic = usesAnthropicMessages(input.model, resolved.npm)
  const efforts = metadata?.reasoningEfforts ?? (anthropic ? [...DEFAULT_ANTHROPIC_EFFORTS] : undefined)

  return {
    ...Model.Info.default(input.providerID, modelID),
    name: metadata?.name ?? displayName(input.model.id),
    ...(metadata?.family ? { family: Model.Family.make(metadata.family) } : {}),
    ...(anthropic ? { package: MESSAGES_PACKAGE } : {}),
    capabilities: {
      tools: metadata?.toolCall ?? !image,
      input:
        metadata?.modalities?.input ??
        (image || supportsAttachments(input.model.id) ? ["text", "image"] : ["text"]),
      output: metadata?.modalities?.output ?? (image ? ["image"] : ["text"]),
    },
    ...(efforts
      ? {
          variants: efforts.map((effort) => ({
            id: Model.VariantID.make(effort),
            settings: anthropic ? anthropicEffort(effort) : { reasoningEffort: effort },
          })),
        }
      : {}),
    ...(metadata?.limit ? { limit: metadata.limit } : {}),
    ...(metadata?.cost
      ? {
          cost: [
            {
              input: money(metadata.cost.input),
              output: money(metadata.cost.output),
              cache: {
                read: money(metadata.cost.cacheRead),
                write: money(metadata.cost.cacheWrite),
              },
            },
          ],
        }
      : {}),
    ...(metadata?.released ? { time: { released: metadata.released } } : {}),
  }
}

export function usesAnthropicMessages(model: CatalogModel, npm?: string) {
  return npm === ANTHROPIC_NPM || model.ownedBy === "anthropic"
}

function anthropicEffort(effort: string) {
  return {
    thinking: { type: "adaptive", display: "summarized" },
    effort,
  }
}

function resolveMetadata(
  catalog: ModelMetadataCatalog,
  model: CatalogModel,
): { metadata?: ModelMetadata; npm?: string } {
  const owner = model.ownedBy ? catalog[model.ownedBy] : undefined
  const owned = owner?.models[model.id]
  if (owned) return { metadata: owned, npm: owned.npm ?? owner?.npm }

  for (const provider of Object.values(catalog)) {
    const metadata = provider.models[model.id]
    if (metadata) return { metadata }
  }

  return { npm: owner?.npm }
}

function discoverMetadata(input: {
  url: string | false
  timeoutMs: number
}): Promise<{ catalog: ModelMetadataCatalog; error?: string }> {
  if (input.url === false) return Promise.resolve({ catalog: {} })

  return discoverModelMetadata({
    url: input.url,
    timeoutMs: input.timeoutMs,
  })
    .then((catalog) => ({ catalog }))
    .catch((error) => ({
      catalog: {},
      error: error instanceof Error ? error.message : String(error),
    }))
}

function readOptions(input: Record<string, unknown>): ConnectorOptions {
  return {
    baseURL: stringOption(input.baseURL),
    apiKey: stringOption(input.apiKey),
    providerID: stringOption(input.providerID),
    providerName: stringOption(input.providerName),
    protocol:
      input.protocol === "responses" ? "responses" : input.protocol === "chat" ? "chat" : undefined,
    modelMetadataURL:
      input.modelMetadataURL === false ? false : stringOption(input.modelMetadataURL),
    discoveryTimeoutMs:
      typeof input.discoveryTimeoutMs === "number" && input.discoveryTimeoutMs > 0
        ? input.discoveryTimeoutMs
        : undefined,
    refreshIntervalMs:
      typeof input.refreshIntervalMs === "number" && input.refreshIntervalMs >= 0
        ? input.refreshIntervalMs
        : undefined,
  }
}

function stringOption(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function money(value: number) {
  return value as Money
}

function displayName(modelID: string) {
  return modelID
    .split("-")
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === "gpt") return "GPT"
      if (lower === "oss") return "OSS"
      if (lower === "codex") return "Codex"
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(" ")
}

function isImageModel(modelID: string) {
  return /(?:^|-)image(?:-|$)/i.test(modelID)
}

function supportsAttachments(modelID: string) {
  return /^(?:claude|gemini|gpt)/i.test(modelID)
}

