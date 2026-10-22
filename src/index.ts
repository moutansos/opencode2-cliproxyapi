import { Model, Plugin, Provider } from "@opencode/plugin"
import {
  acquireMetadataLock,
  catalogCacheIsFresh,
  metadataCacheIsFresh,
  readCatalogCache,
  readMetadataCache,
  writeCatalogCache,
  writeMetadataCache,
} from "./cache.js"
import {
  discoverModelMetadata,
  discoverModels,
  normalizeBaseURL,
  type CatalogModel,
  type LiveMetadata,
  type ModelMetadata,
  type ModelMetadataCatalog,
} from "./catalog.js"

const DEFAULT_BASE_URL = "http://localhost:8317/v1"
const DEFAULT_PROVIDER_ID = "cliproxyapi"
const DEFAULT_PROVIDER_NAME = "CLIProxyAPI"
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000
const DEFAULT_MODEL_METADATA_URL = "https://models.dev/api.json"
const DEFAULT_REFRESH_MS = 5 * 60_000
const METADATA_LOCK_POLL_MS = 50

// Lets tests drive a refresh without waiting on the interval timer, and wait
// until the background refresh has released the network.
export const pluginTesting = {
  refresh: undefined as undefined | (() => Promise<void>),
  settled: Promise.resolve() as Promise<void>,
}

const CHAT_PACKAGE = "@opencode/ai/providers/openai-compatible"
// OpenCode resolves these package names from inside its own compiled bundle, not
// from `node_modules`. Only the subpaths the bundle itself contains can be
// imported, so Responses must use the OpenAI facade; the sibling
// `openai-compatible-responses` module (and the `openai-compatible/responses`
// subpath) are not bundled and fail at model init with `Cannot find package
// '@opencode/ai' imported from /$bunfs/root/chunk-*.js`.
const RESPONSES_PACKAGE = "@opencode/ai/providers/openai/responses"
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

// When a server supplies a context window but no output limit, an inherited
// (catalog or default) output budget is capped to this fraction of the context so
// the remaining prompt budget stays usable.
const INHERITED_OUTPUT_CONTEXT_DIVISOR = 4

type Cost = Model.Info["cost"][number]
type Limit = Model.Info["limit"]
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
    const metadataURL = options.modelMetadataURL ?? DEFAULT_MODEL_METADATA_URL
    // The catalog is not secret and does not vary by credential. Keying only on
    // the server lets every location share one cache entry.
    const catalogCacheKey = baseURL

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

    let catalog: CatalogModel[] = []
    let metadata: ModelMetadataCatalog = {}
    let registered = false
    let closed = false
    let refreshPromise: Promise<void> | undefined

    const rebuild = async (reload: boolean) => {
      if (closed) return
      source.models = catalog.map((model) => buildModel({ providerID, model, metadata }))
      if (reload && registered && !closed) await ctx.provider.reload()
    }

    const refreshCatalog = async (reload: boolean, fresh = false) => {
      let discovered: CatalogModel[]
      try {
        discovered = await loadCatalog({ baseURL, apiKey, timeoutMs, fresh })
      } catch (error) {
        if (closed) return
        // Keep the previous entry unchanged, including its fetchedAt. Rewriting
        // it would make a failed server look freshly discovered.
        const recovered = await readCatalogCache(catalogCacheKey).catch(() => undefined)
        if (!recovered?.models.length) throw error
        catalog = recovered.models
        await rebuild(reload)
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[cliproxyapi] catalog refresh failed, using cached models: ${message}`)
        return
      }

      catalog = discovered
      await writeCatalogCache(catalogCacheKey, catalog).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[cliproxyapi] could not update the catalog cache: ${message}`)
      })
      if (closed) return
      await rebuild(reload)
      console.log(`[cliproxyapi] discovered ${catalog.length} models from ${baseURL}`)
    }

    const refreshMetadata = async () => {
      if (metadataURL === false || closed || catalog.length === 0) return
      const result = await loadModelMetadata({
        url: metadataURL,
        timeoutMs,
        isClosed: () => closed,
      })
      if (closed || catalog.length === 0) return
      // A failed download must not wipe metadata already in use. An empty
      // successful catalog is authoritative and clears stale enrichment.
      if (result.stale) {
        if (Object.keys(metadata).length > 0 || Object.keys(result.catalog).length === 0) return
      }
      metadata = result.catalog
      await rebuild(true)
    }

    // A previous process may already have the catalogs. Use them immediately so
    // models are available even when this process loses the download race, then
    // refresh in the background.
    const [cachedCatalog, cachedMetadata] = await Promise.all([
      readCatalogCache(catalogCacheKey).catch(() => undefined),
      metadataURL === false
        ? Promise.resolve(undefined)
        : readMetadataCache(metadataURL).catch(() => undefined),
    ])
    if (cachedCatalog?.models.length) catalog = cachedCatalog.models
    if (cachedMetadata) metadata = cachedMetadata.catalog
    if (catalog.length > 0) await rebuild(false)

    // Register the provider immediately so activation never depends on a
    // network request. The model list is filled in by the background refresh
    // below, and the provider is reloaded once it is available.
    await ctx.provider.transform((editor) => {
      editor.add({ info: source.info, models: source.models })
    })
    registered = true

    await ctx.session.hook(
      "model.request",
      (event) => {
        if (!apiKey) return
        event.headers.authorization ??= `Bearer ${apiKey}`
      },
      { providerID },
    )

    const refresh = () => {
      if (closed) return Promise.resolve()
      if (refreshPromise) return refreshPromise

      refreshPromise = (async () => {
        try {
          // Fetch the CLIProxyAPI catalog first. Metadata is large and must not
          // compete with model discovery when several locations load at once.
          await refreshCatalog(true, true)
          if (closed) return
          await refreshMetadata()
        } finally {
          refreshPromise = undefined
        }
      })()
      pluginTesting.settled = refreshPromise.catch((error) => {
        console.warn(
          `[cliproxyapi] catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })

      return refreshPromise
    }
    pluginTesting.refresh = refresh

    void refresh()

    const cleanup = () => {
      closed = true
      if (pluginTesting.refresh === refresh) pluginTesting.refresh = undefined
    }

    if (refreshMs <= 0) return cleanup

    const timer = setInterval(() => {
      void refresh()
    }, refreshMs)
    timer.unref?.()
    return () => {
      cleanup()
      clearInterval(timer)
    }
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
  const defaults = Model.Info.default(input.providerID, modelID)
  const limit = resolveLimit({
    live: input.model.live?.limit,
    catalog: metadata?.limit,
    fallback: defaults.limit,
  })

  return {
    ...defaults,
    name: input.model.live?.name ?? metadata?.name ?? displayName(input.model.id),
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
    ...(limit ? { limit } : {}),
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

/**
 * Merges token limits per field. Live CLIProxyAPI metadata wins over the
 * models.dev-compatible catalog, which wins over OpenCode's defaults. Explicit
 * user configuration is layered on top by OpenCode itself.
 *
 * Coherence policy when a live value is present:
 * - a live output limit is kept, but never exceeds the effective context;
 * - with a live context and no live output, an inherited output budget is capped
 *   to a quarter of the live context (so a small deployment window is not
 *   consumed by a catalog-sized output reservation);
 * - an inherited input limit is capped to context minus output.
 * Without live limits the catalog limit is used unchanged.
 */
export function resolveLimit(input: {
  live?: LiveMetadata["limit"]
  catalog?: ModelMetadata["limit"]
  fallback: Limit
}): Limit | undefined {
  const { live, catalog, fallback } = input
  if (!live || (live.context === undefined && live.output === undefined)) return catalog

  const context = live.context ?? catalog?.context ?? fallback.context
  const inheritedOutput = catalog?.output ?? fallback.output
  let output: number
  if (live.output !== undefined) {
    output = Math.min(live.output, context)
  } else {
    output = Math.min(inheritedOutput, Math.max(1, Math.floor(context / INHERITED_OUTPUT_CONTEXT_DIVISOR)))
  }
  const inheritedInput = catalog?.input
  const inputLimit =
    inheritedInput === undefined ? undefined : Math.max(1, Math.min(inheritedInput, context - output))

  return {
    context,
    ...(inputLimit !== undefined ? { input: inputLimit } : {}),
    output,
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

// OpenCode may activate the same plugin once per location, sometimes in a
// separate process. Share in-flight requests within this process, and use the
// disk cache and metadata lock to coordinate across processes.
const catalogRequests = new Map<string, Promise<CatalogModel[]>>()

function loadCatalog(input: {
  baseURL: string
  apiKey?: string
  timeoutMs: number
  fresh?: boolean
}) {
  // Share a download within one process only when it uses the same credential.
  // The disk cache is keyed by server alone; see catalogCacheKey.
  const requestKey = `${input.baseURL}\0${input.apiKey ?? ""}`
  const existing = catalogRequests.get(requestKey)
  if (existing) return existing

  const pending = (async () => {
    if (!input.fresh) {
      const cached = await readCatalogCache(input.baseURL).catch(() => undefined)
      if (cached && catalogCacheIsFresh(cached.fetchedAt) && cached.models.length > 0) {
        return cached.models
      }
    }
    return discoverModels(input)
  })().finally(() => {
    catalogRequests.delete(requestKey)
  })

  catalogRequests.set(requestKey, pending)
  return pending
}

type ModelMetadataDiscovery = {
  catalog: ModelMetadataCatalog
  /** True when this is a fallback, not a completed fetch. */
  stale?: boolean
  error?: string
}

const metadataRequests = new Map<string, Promise<ModelMetadataDiscovery>>()

function loadModelMetadata(input: {
  url: string | false
  timeoutMs: number
  isClosed?: () => boolean
}): Promise<ModelMetadataDiscovery> {
  if (input.url === false) return Promise.resolve({ catalog: {} })

  const url = input.url
  const existing = metadataRequests.get(url)
  if (existing) return existing

  const pending = discoverSharedMetadata(url, input.timeoutMs, input.isClosed ?? (() => false)).finally(
    () => {
      metadataRequests.delete(url)
    },
  )

  metadataRequests.set(url, pending)
  return pending
}

async function discoverSharedMetadata(
  url: string,
  timeoutMs: number,
  isClosed: () => boolean,
): Promise<ModelMetadataDiscovery> {
  const cached = await readMetadataCache(url).catch(() => undefined)
  if (cached && metadataCacheIsFresh(cached.fetchedAt)) return { catalog: cached.catalog }

  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireMetadataLock(url)
  } catch (error) {
    // A cache directory that cannot be created should not disable enrichment.
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[cliproxyapi] metadata lock unavailable, downloading anyway: ${message}`)
    return fetchMetadata(url, timeoutMs, cached?.catalog)
  }

  if (!release) {
    // Another process is already downloading. Wait for its cache instead of
    // starting a second download or skipping enrichment until the next refresh.
    const waited = await waitForSharedMetadata(url, timeoutMs, isClosed)
    if (waited && metadataCacheIsFresh(waited.fetchedAt)) return { catalog: waited.catalog }
    return { catalog: waited?.catalog ?? cached?.catalog ?? {}, stale: true }
  }

  try {
    return await fetchMetadata(url, timeoutMs, cached?.catalog)
  } finally {
    await release()
  }
}

async function fetchMetadata(
  url: string,
  timeoutMs: number,
  fallback: ModelMetadataCatalog | undefined,
): Promise<ModelMetadataDiscovery> {
  try {
    const catalog = await discoverModelMetadata({ url, timeoutMs })
    // A completed response is authoritative, including an empty catalog.
    await writeMetadataCache(url, catalog).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[cliproxyapi] could not update the metadata cache: ${message}`)
    })
    return { catalog }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[cliproxyapi] ${message}`)
    return { catalog: fallback ?? {}, stale: true, error: message }
  }
}

async function waitForSharedMetadata(
  url: string,
  timeoutMs: number,
  isClosed: () => boolean,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isClosed()) return
    const cached = await readMetadataCache(url).catch(() => undefined)
    if (cached && metadataCacheIsFresh(cached.fetchedAt)) return cached
    await sleep(METADATA_LOCK_POLL_MS)
  }
  return readMetadataCache(url).catch(() => undefined)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

