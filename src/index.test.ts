import { describe, expect, test } from "bun:test"
import type { Model, Plugin as PluginTypes, Provider } from "@opencode/plugin"
import plugin, { buildModel } from "./index.js"

type Registered = {
  info: Provider.Info
  models: readonly Model.Info[]
}

function context(options: Record<string, unknown>) {
  const registered: Registered[] = []

  return {
    registered,
    ctx: {
      options,
      provider: {
        transform: async (callback: (editor: { add: (input: Registered) => void }) => void) => {
          callback({ add: (input) => registered.push(input) })
          return { dispose: async () => {} }
        },
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
        "@opencode/ai/providers/openai-compatible/responses",
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

    expect(model.package).toBe("@opencode/ai/providers/anthropic-compatible")
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

  test("leaves other models on the provider protocol", () => {
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
