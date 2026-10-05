export type CatalogModel = {
  id: string
  ownedBy?: string
  live?: LiveMetadata
}

/**
 * Optional deployment metadata a CLIProxyAPI server may add to `/v1/models`
 * entries. Stock CLIProxyAPI only returns `id`, `object`, `created`, and
 * `owned_by`; these fields require server-side enrichment (for example a
 * CLIProxyAPI plugin). Only the recognized fields below are read:
 *
 * | Wire field              | Meaning                          |
 * | ----------------------- | -------------------------------- |
 * | `display_name`          | Human-readable model name        |
 * | `context_length`        | Deployment context window        |
 * | `max_completion_tokens` | Deployment output-token limit    |
 */
export type LiveMetadata = {
  name?: string
  limit?: {
    context?: number
    output?: number
  }
}

export type ModelMetadata = {
  npm?: string
  name?: string
  family?: string
  toolCall?: boolean
  modalities?: {
    input: string[]
    output: string[]
  }
  limit?: {
    context: number
    input?: number
    output: number
  }
  cost?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  released?: number
  reasoningEfforts?: string[]
}

export type ModelMetadataCatalog = Record<
  string,
  {
    npm?: string
    models: Record<string, ModelMetadata>
  }
>

type CatalogResponse = {
  data?: unknown
}

export function normalizeBaseURL(value: string) {
  const url = new URL(value)
  const pathname = url.pathname.replace(/\/+$/, "")
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`
  return url.toString().replace(/\/$/, "")
}

export function parseCatalog(input: unknown): CatalogModel[] {
  if (!isRecord(input)) throw new Error("CLIProxyAPI returned a non-object model catalog")

  const response: CatalogResponse = input
  if (!Array.isArray(response.data)) throw new Error("CLIProxyAPI model catalog is missing the data array")

  const models = response.data
    .map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") return
      const live = parseLiveMetadata(item)
      return {
        id: item.id,
        ...(typeof item.owned_by === "string" ? { ownedBy: item.owned_by } : {}),
        ...(live ? { live } : {}),
      }
    })
    .filter((item): item is CatalogModel => item !== undefined)

  if (models.length === 0) throw new Error("CLIProxyAPI returned no usable models")

  const unique = new Map<string, CatalogModel>()
  for (const model of models) {
    if (!unique.has(model.id)) unique.set(model.id, model)
  }
  return [...unique.values()]
}

export async function discoverModels(input: {
  baseURL: string
  apiKey?: string
  timeoutMs: number
  fetcher?: typeof fetch
}) {
  const response = await (input.fetcher ?? fetch)(`${input.baseURL}/models`, {
    headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined,
    signal: AbortSignal.timeout(input.timeoutMs),
  })

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300)
    throw new Error(
      `CLIProxyAPI model discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  return parseCatalog(await response.json())
}

export function parseModelMetadataCatalog(input: unknown): ModelMetadataCatalog {
  if (!isRecord(input)) throw new Error("Model metadata service returned a non-object catalog")

  return Object.fromEntries(
    Object.entries(input).flatMap(([providerID, provider]) => {
      if (!isRecord(provider)) return []

      const models = Object.fromEntries(
        Object.entries(isRecord(provider.models) ? provider.models : {}).flatMap(([modelID, model]) => {
          if (!isRecord(model)) return []
          return [[modelID, parseModelMetadata(model)]]
        }),
      )

      const npm = typeof provider.npm === "string" ? provider.npm : undefined
      return npm || Object.keys(models).length > 0
        ? [[providerID, { ...(npm ? { npm } : {}), models }]]
        : []
    }),
  )
}

export async function discoverModelMetadata(input: {
  url: string
  timeoutMs: number
  fetcher?: typeof fetch
}) {
  const response = await (input.fetcher ?? fetch)(input.url, {
    signal: AbortSignal.timeout(input.timeoutMs),
  })

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300)
    throw new Error(
      `Model metadata discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  return parseModelMetadataCatalog(await response.json())
}

function parseModelMetadata(model: Record<string, unknown>): ModelMetadata {
  const provider = isRecord(model.provider) ? model.provider : undefined
  const modalities = isRecord(model.modalities) ? model.modalities : undefined
  const limit = isRecord(model.limit) ? model.limit : undefined
  const cost = isRecord(model.cost) ? model.cost : undefined
  const released = typeof model.release_date === "string" ? Date.parse(model.release_date) : Number.NaN
  const reasoningEfforts = parseReasoningEfforts(model.reasoning_options)

  return {
    ...(provider && typeof provider.npm === "string" ? { npm: provider.npm } : {}),
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    ...(typeof model.family === "string" ? { family: model.family } : {}),
    ...(typeof model.tool_call === "boolean" ? { toolCall: model.tool_call } : {}),
    ...(modalities && isStringArray(modalities.input) && isStringArray(modalities.output)
      ? { modalities: { input: modalities.input, output: modalities.output } }
      : {}),
    ...(limit && typeof limit.context === "number" && typeof limit.output === "number"
      ? {
          limit: {
            context: limit.context,
            ...(typeof limit.input === "number" ? { input: limit.input } : {}),
            output: limit.output,
          },
        }
      : {}),
    ...(cost && typeof cost.input === "number" && typeof cost.output === "number"
      ? {
          cost: {
            input: cost.input,
            output: cost.output,
            cacheRead: typeof cost.cache_read === "number" ? cost.cache_read : 0,
            cacheWrite: typeof cost.cache_write === "number" ? cost.cache_write : 0,
          },
        }
      : {}),
    ...(Number.isFinite(released) ? { released } : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
  }
}

function parseReasoningEfforts(input: unknown) {
  if (!Array.isArray(input)) return
  for (const option of input) {
    if (!isRecord(option) || option.type !== "effort") continue
    if (isStringArray(option.values) && option.values.length > 0) return option.values
  }
}

export function parseLiveMetadata(item: Record<string, unknown>): LiveMetadata | undefined {
  const name =
    typeof item.display_name === "string" && item.display_name.trim() !== ""
      ? item.display_name.trim()
      : undefined
  const context = tokenLimit(item.context_length)
  const output = tokenLimit(item.max_completion_tokens)
  const limit = {
    ...(context !== undefined ? { context } : {}),
    ...(output !== undefined ? { output } : {}),
  }
  if (name === undefined && Object.keys(limit).length === 0) return
  return {
    ...(name !== undefined ? { name } : {}),
    ...(Object.keys(limit).length > 0 ? { limit } : {}),
  }
}

/** Token limits must be finite positive integers; anything else is ignored. */
function tokenLimit(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
