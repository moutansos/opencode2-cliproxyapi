import { describe, expect, test } from "bun:test"
import type { Model, Plugin as PluginTypes, Provider } from "@opencode/plugin"
import plugin, { buildModel, resolveLimit } from "./index.js"

type Registered = {
  info: Provider.Info
  models: readonly Model.Info[]
}

function context(
  options: Record<string, unknown>,
  existing?: { settings?: Record<string, unknown> },
) {
  const registered: Registered[] = []
  const transforms: Array<(editor: { add: (input: Registered) => void }) => void> = []

  return {
    registered,
    ctx: {
      options: { refreshIntervalMs: 0, ...options },
      provider: {
        get: async () => {
          if (!existing) throw new Error("provider not found")
          return { data: existing }
        },
        transform: async (callback: (editor: { add: (input: Registered) => void }) => void) => {
          transforms.push(callback)
          callback({ add: (input) => registered.push(input) })
          return { dispose: async () => {} }
        },
        reload: async () => {
          for (const callback of transforms) callback({ add: (input) => registered.push(input) })
        },
      },
      aisdk: {
        hook: async () => ({ dispose: async () => {} }),
      },
      session: {
        hook: async () => ({ dispose: async () => {} }),
      },
    } as unknown as PluginTypes.Context,
  }
}

describe("plugin", () => {
  test("registers a provider from the discovered CLIProxyAPI catalog", async () => {
    const requests: Request[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input as RequestInfo, init))
      return Response.json({
        data: [{ id: "gpt-5.6-terra" }, { id: "gemini-3.1-flash-image" }],
      })
    }

    try {
      const { ctx, registered } = context({
        baseURL: "http://cliproxy.test:8317",
        apiKey: "secret",
      })

      await plugin.setup(ctx)

      expect(requests).toHaveLength(2)
      const modelRequest = requests.find(
        (request) => request.url === "http://cliproxy.test:8317/v1/models",
      )
      expect(modelRequest?.headers.get("authorization")).toBe("Bearer secret")
      expect(requests.some((request) => request.url === "https://models.dev/api.json")).toBe(true)

      expect(registered).toHaveLength(1)
      expect(registered[0]?.info).toMatchObject({
        id: "cliproxyapi",
        name: "CLIProxyAPI",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: "http://cliproxy.test:8317/v1",
          apiKey: "secret",
        },
      })
      expect(registered[0]?.models.map((model) => model.id)).toEqual([
        "gpt-5.6-terra",
        "gemini-3.1-flash-image",
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("reads connection settings from an existing provider config", async () => {
    const requests: Request[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input as RequestInfo, init))
      return Response.json({ data: [{ id: "chat-model" }] })
    }

    try {
      const { ctx, registered } = context(
        { modelMetadataURL: false },
        {
          settings: {
            baseURL: "http://cliproxy.test:8317/v1",
            apiKey: "from-config",
          },
        },
      )

      await plugin.setup(ctx)

      const modelRequest = requests.find(
        (request) => request.url === "http://cliproxy.test:8317/v1/models",
      )
      expect(modelRequest?.headers.get("authorization")).toBe("Bearer from-config")
      expect(registered[0]?.info.settings).toMatchObject({
        baseURL: "http://cliproxy.test:8317/v1",
        apiKey: "from-config",
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("selects the responses package when configured", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => Response.json({ data: [{ id: "chat-model" }] })

    try {
      const { ctx, registered } = context({
        baseURL: "http://cliproxy.test:8317",
        protocol: "responses",
        modelMetadataURL: false,
      })

      await plugin.setup(ctx)

      expect(registered[0]?.info.package).toBe(
        "@opencode/ai/providers/openai/responses",
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("keeps discovered models available when model metadata is unavailable", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") {
        return Response.json({ error: "unavailable" }, { status: 503 })
      }
      return Response.json({ data: [{ id: "chat-model", owned_by: "acme" }] })
    }

    try {
      const { ctx, registered } = context({ baseURL: "http://cliproxy.test:8317" })

      await plugin.setup(ctx)

      expect(registered[0]?.models.map((model) => model.id)).toEqual(["chat-model"])
      expect(registered[0]?.models[0]?.package).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("buildModel", () => {
  const providerID = "cliproxyapi" as Provider.ID
  const metadata = {
    acme: {
      npm: "@ai-sdk/anthropic",
      models: {
        "messages-model": {
          name: "Messages Model",
          family: "messages",
          toolCall: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 200_000, output: 64_000 },
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          released: Date.parse("2026-01-15"),
          reasoningEfforts: ["low", "high", "max"],
        },
        "model-level-chat": {
          npm: "@ai-sdk/openai-compatible",
        },
      },
    },
    chat: {
      npm: "@ai-sdk/openai-compatible",
      models: {},
    },
  }

  test("routes Anthropic-compatible models through the messages package", () => {
    const model = buildModel({
      providerID,
      model: { id: "messages-model", ownedBy: "acme" },
      metadata,
    })

    expect(model.package).toBe("@opencode/ai/providers/anthropic")
    expect(model.name).toBe("Messages Model")
    expect(model.family).toBe("messages")
    expect(model.capabilities).toEqual({
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    })
    expect(model.limit).toEqual({ context: 200_000, output: 64_000 })
    expect(model.cost).toEqual([
      { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    ] as Model.Info["cost"])
  })

  test("builds Anthropic thinking variants from model metadata", () => {
    expect(
      buildModel({ providerID, model: { id: "messages-model", ownedBy: "acme" }, metadata })
        .variants,
    ).toEqual([
      {
        id: "low",
        settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
      },
      {
        id: "high",
        settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
      },
      {
        id: "max",
        settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
      },
    ] as Model.Info["variants"])
  })

  test("uses OpenAI reasoningEffort variants for non-Anthropic models", () => {
    expect(
      buildModel({
        providerID,
        model: { id: "gpt-5.6-luna", ownedBy: "openai" },
        metadata: {
          openai: {
            models: { "gpt-5.6-luna": { reasoningEfforts: ["none", "low", "high"] } },
          },
        },
      }).variants,
    ).toEqual([
      { id: "none", settings: { reasoningEffort: "none" } },
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ] as Model.Info["variants"])
  })

  test("defaults Claude models without metadata to the messages package", () => {
    const model = buildModel({
      providerID,
      model: { id: "claude-opus-5", ownedBy: "anthropic" },
      metadata: {},
    })
    expect(model.package).toBe("@opencode/ai/providers/anthropic")
    expect(model.variants.map((variant) => variant.id)).toEqual(["low", "medium", "high"])
  })

  test("leaves OpenAI-compatible models on the provider package", () => {
    expect(
      buildModel({ providerID, model: { id: "chat-model", ownedBy: "chat" }, metadata }).package,
    ).toBeUndefined()
    expect(
      buildModel({ providerID, model: { id: "model-level-chat", ownedBy: "acme" }, metadata })
        .package,
    ).toBeUndefined()
  })

  test("infers capabilities for models missing from the metadata catalog", () => {
    const image = buildModel({
      providerID,
      model: { id: "gemini-3.1-flash-image" },
      metadata: {},
    })

    expect(image.name).toBe("Gemini 3.1 Flash Image")
    expect(image.capabilities).toEqual({
      tools: false,
      input: ["text", "image"],
      output: ["image"],
    })

    const text = buildModel({ providerID, model: { id: "qwen3-coder" }, metadata: {} })
    expect(text.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
  })
})

describe("live CLIProxyAPI metadata", () => {
  const providerID = "cliproxyapi" as Provider.ID
  const catalog = {
    acme: {
      models: {
        "deployment-coder": {
          name: "Catalog Coder",
          family: "coder",
          toolCall: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 131_072, input: 120_000, output: 32_768 },
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      },
    },
  }

  test("live context and output override the catalog", () => {
    const model = buildModel({
      providerID,
      model: {
        id: "deployment-coder",
        ownedBy: "acme",
        live: { name: "Deployment Coder", limit: { context: 8_192, output: 2_048 } },
      },
      metadata: catalog,
    })
    expect(model.limit).toEqual({ context: 8_192, input: 6_144, output: 2_048 })
    expect(model.name).toBe("Deployment Coder")
    expect(model.family).toBe("coder")
    expect(model.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
    expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 } }] as Model.Info["cost"])
  })

  test("context-only live metadata caps the inherited output budget", () => {
    const model = buildModel({
      providerID,
      model: { id: "deployment-coder", ownedBy: "acme", live: { limit: { context: 8_192 } } },
      metadata: catalog,
    })
    expect(model.limit).toEqual({ context: 8_192, input: 6_144, output: 2_048 })
    expect(model.name).toBe("Catalog Coder")
  })

  test("output-only live metadata keeps the catalog context", () => {
    const model = buildModel({
      providerID,
      model: { id: "deployment-coder", ownedBy: "acme", live: { limit: { output: 4_096 } } },
      metadata: catalog,
    })
    expect(model.limit).toEqual({ context: 131_072, input: 120_000, output: 4_096 })
  })

  test("live limits work without a catalog match", () => {
    const model = buildModel({
      providerID,
      model: { id: "local/qwen3:8b", ownedBy: "ollama", live: { limit: { context: 32_768 } } },
      metadata: {},
    })
    expect(model.limit).toEqual({ context: 32_768, output: 8_192 })

    const large = buildModel({
      providerID,
      model: { id: "local/large", live: { limit: { context: 196_608 } } },
      metadata: {},
    })
    expect(large.limit).toEqual({ context: 196_608, output: 32_000 })
  })

  test("basic records keep the existing catalog and default behavior", () => {
    expect(
      buildModel({ providerID, model: { id: "deployment-coder", ownedBy: "acme" }, metadata: catalog }).limit,
    ).toEqual({ context: 131_072, input: 120_000, output: 32_768 })
    const plain = buildModel({ providerID, model: { id: "unknown-model" }, metadata: {} })
    expect(plain.limit).toEqual(
      buildModel({ providerID, model: { id: "other-unknown" }, metadata: {} }).limit,
    )
  })

  test("live limits keep explicit falsy catalog metadata", () => {
    const model = buildModel({
      providerID,
      model: { id: "no-tools", ownedBy: "acme", live: { limit: { context: 8_192 } } },
      metadata: {
        acme: {
          models: {
            "no-tools": {
              toolCall: false,
              limit: { context: 65_536, output: 1_024 },
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
        },
      },
    })
    expect(model.capabilities.tools).toBe(false)
    expect(model.limit).toEqual({ context: 8_192, output: 1_024 })
    expect(model.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }] as Model.Info["cost"])
  })

  test("resolveLimit never lets output exceed the effective context", () => {
    const fallback = { context: 200_000, output: 32_000 }
    expect(resolveLimit({ live: { context: 4_096, output: 8_192 }, fallback })).toEqual({
      context: 4_096,
      output: 4_096,
    })
    expect(resolveLimit({ live: { context: 2 }, fallback })).toEqual({ context: 2, output: 1 })
    expect(resolveLimit({ live: {}, catalog: { context: 10, output: 5 }, fallback })).toEqual({
      context: 10,
      output: 5,
    })
    expect(resolveLimit({ fallback })).toBeUndefined()
  })
})

describe("plugin live metadata", () => {
  const enriched = (context: number | undefined) => ({
    object: "list",
    data: [
      {
        id: "local/qwen3:8b",
        object: "model",
        owned_by: "ollama",
        display_name: "qwen3:8b (Ollama)",
        ...(context !== undefined ? { context_length: context } : {}),
      },
    ],
  })

  test("uses live limits when enrichment is disabled or fails", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const modelMetadataURL of [false, "https://catalog.test/api.json"] as const) {
        globalThis.fetch = async (input) => {
          if (String(input) === "https://catalog.test/api.json") {
            return Response.json({ error: "unavailable" }, { status: 503 })
          }
          return Response.json(enriched(16_384))
        }
        const { ctx, registered } = context({ baseURL: "http://cliproxy.test:8317", modelMetadataURL })
        await plugin.setup(ctx)
        const model = registered.at(-1)?.models[0]
        expect(model?.limit).toEqual({ context: 16_384, output: 4_096 })
        expect(model?.name).toBe("qwen3:8b (Ollama)")
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("refresh applies changed and removed live metadata for an unchanged model ID", async () => {
    const originalFetch = globalThis.fetch
    const responses = [enriched(8_192), enriched(32_768), enriched(undefined)]
    let calls = 0
    globalThis.fetch = async () => Response.json(responses[Math.min(calls++, responses.length - 1)])

    let cleanup: void | (() => void | Promise<void>)
    try {
      const { ctx, registered } = context({
        baseURL: "http://cliproxy.test:8317",
        modelMetadataURL: false,
        refreshIntervalMs: 10,
      })
      cleanup = await plugin.setup(ctx)
      expect(registered.at(-1)?.models[0]?.limit).toEqual({ context: 8_192, output: 2_048 })

      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5)
      }
      await waitFor(() => registered.at(-1)?.models[0]?.limit.context === 32_768)
      expect(registered.at(-1)?.models[0]?.limit).toEqual({ context: 32_768, output: 8_192 })

      await waitFor(() => registered.at(-1)?.models[0]?.limit.context !== 32_768)
      const defaults = buildModel({
        providerID: "cliproxyapi" as Provider.ID,
        model: { id: "local/qwen3:8b" },
        metadata: {},
      }).limit
      expect(registered.at(-1)?.models[0]?.limit).toEqual(defaults)
      expect(registered.at(-1)?.models.map((model) => model.id)).toEqual(["local/qwen3:8b"])
    } finally {
      if (typeof cleanup === "function") await cleanup()
      globalThis.fetch = originalFetch
    }
  })
})
