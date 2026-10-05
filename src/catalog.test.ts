import { describe, expect, test } from "bun:test"
import {
  discoverModelMetadata,
  discoverModels,
  normalizeBaseURL,
  parseCatalog,
  parseLiveMetadata,
  parseModelMetadataCatalog,
} from "./catalog.js"

describe("normalizeBaseURL", () => {
  test.each([
    ["http://cliproxy.test:8317", "http://cliproxy.test:8317/v1"],
    ["http://cliproxy.test:8317/", "http://cliproxy.test:8317/v1"],
    ["http://cliproxy.test:8317/v1", "http://cliproxy.test:8317/v1"],
    ["https://example.com/proxy/", "https://example.com/proxy/v1"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeBaseURL(input)).toBe(expected)
  })
})

describe("parseCatalog", () => {
  test("returns unique valid models", () => {
    expect(
      parseCatalog({
        object: "list",
        data: [
          { id: "gpt-5.6-terra", object: "model", owned_by: "openai" },
          { id: "claude-sonnet-4-6", object: "model" },
          { id: "gpt-5.6-terra", object: "model" },
          { id: "" },
          null,
        ],
      }),
    ).toEqual([
      { id: "gpt-5.6-terra", ownedBy: "openai" },
      { id: "claude-sonnet-4-6" },
    ])
  })

  test("keeps recognized live metadata from enriched entries", () => {
    expect(
      parseCatalog({
        object: "list",
        data: [
          {
            id: "deployment-coder",
            object: "model",
            owned_by: "local-provider",
            display_name: "Deployment Coder",
            context_length: 8192,
            max_completion_tokens: 2048,
            unknown_field: { nested: true },
          },
          { id: "context-only", context_length: 4096 },
          { id: "basic", owned_by: "openai" },
        ],
      }),
    ).toEqual([
      {
        id: "deployment-coder",
        ownedBy: "local-provider",
        live: { name: "Deployment Coder", limit: { context: 8192, output: 2048 } },
      },
      { id: "context-only", live: { limit: { context: 4096 } } },
      { id: "basic", ownedBy: "openai" },
    ])
  })

  test("ignores malformed live metadata without dropping the model", () => {
    const models = parseCatalog({
      data: [
        {
          id: "bad-limits",
          display_name: "   ",
          context_length: -1,
          max_completion_tokens: 1.5,
        },
        { id: "string-limits", context_length: "8192", max_completion_tokens: null },
        { id: "huge", context_length: Number.POSITIVE_INFINITY, max_completion_tokens: 0 },
      ],
    })
    expect(models).toEqual([{ id: "bad-limits" }, { id: "string-limits" }, { id: "huge" }])
  })

  test("rejects malformed responses", () => {
    expect(() => parseCatalog({ data: {} })).toThrow("missing the data array")
    expect(() => parseCatalog({ data: [] })).toThrow("no usable models")
  })
})

describe("discoverModels", () => {
  test("uses bearer authentication", async () => {
    let authorization = ""
    const models = await discoverModels({
      baseURL: "http://cliproxy.test/v1",
      apiKey: "secret",
      timeoutMs: 1_000,
      fetcher: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? ""
        return Response.json({ data: [{ id: "gemini-3.1-pro-low" }] })
      },
    })

    expect(authorization).toBe("Bearer secret")
    expect(models).toEqual([{ id: "gemini-3.1-pro-low" }])
  })

  test("reports an API error without hiding its useful detail", async () => {
    await expect(
      discoverModels({
        baseURL: "http://cliproxy.test/v1",
        timeoutMs: 1_000,
        fetcher: async () => Response.json({ error: "Missing API key" }, { status: 401 }),
      }),
    ).rejects.toThrow('HTTP 401: {"error":"Missing API key"}')
  })
})

describe("parseModelMetadataCatalog", () => {
  test("indexes provider defaults and model capabilities", () => {
    expect(
      parseModelMetadataCatalog({
        acme: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "chat-model": {},
            "messages-model": {
              name: "Messages Model",
              family: "messages",
              tool_call: true,
              release_date: "2026-01-15",
              reasoning_options: [
                { type: "effort", values: ["low", "high"] },
                { type: "toggle" },
              ],
              modalities: {
                input: ["text", "image"],
                output: ["text"],
              },
              limit: {
                context: 200000,
                output: 64000,
              },
              cost: {
                input: 3,
                output: 15,
                cache_read: 0.3,
              },
              provider: {
                npm: "@ai-sdk/anthropic",
              },
            },
          },
        },
        malformed: {
          models: [],
        },
      }),
    ).toEqual({
      acme: {
        npm: "@ai-sdk/openai-compatible",
        models: {
          "chat-model": {},
          "messages-model": {
            npm: "@ai-sdk/anthropic",
            name: "Messages Model",
            family: "messages",
            toolCall: true,
            modalities: {
              input: ["text", "image"],
              output: ["text"],
            },
            limit: {
              context: 200000,
              output: 64000,
            },
            cost: {
              input: 3,
              output: 15,
              cacheRead: 0.3,
              cacheWrite: 0,
            },
            released: Date.parse("2026-01-15"),
            reasoningEfforts: ["low", "high"],
          },
        },
      },
    })
  })

  test("ignores reasoning options that do not describe effort levels", () => {
    const catalog = parseModelMetadataCatalog({
      acme: {
        models: {
          "budget-model": {
            reasoning_options: [{ type: "budget_tokens", min: 1024 }, { type: "toggle" }],
          },
        },
      },
    })

    expect(catalog.acme?.models["budget-model"]?.reasoningEfforts).toBeUndefined()
  })

  test("rejects a malformed catalog", () => {
    expect(() => parseModelMetadataCatalog([])).toThrow("non-object catalog")
  })
})

describe("discoverModelMetadata", () => {
  test("fetches model metadata from the configured URL", async () => {
    let requestedURL = ""
    const catalog = await discoverModelMetadata({
      url: "https://metadata.test/models.json",
      timeoutMs: 1_000,
      fetcher: async (input) => {
        requestedURL = String(input)
        return Response.json({
          acme: {
            models: {
              "messages-model": {
                provider: {
                  npm: "@ai-sdk/anthropic",
                },
              },
            },
          },
        })
      },
    })

    expect(requestedURL).toBe("https://metadata.test/models.json")
    expect(catalog).toEqual({
      acme: {
        models: {
          "messages-model": {
            npm: "@ai-sdk/anthropic",
          },
        },
      },
    })
  })
})

describe("parseLiveMetadata", () => {
  test("returns nothing for basic OpenAI records", () => {
    expect(parseLiveMetadata({ id: "gpt-5", object: "model", owned_by: "openai" })).toBeUndefined()
  })

  test("keeps output-only and name-only metadata", () => {
    expect(parseLiveMetadata({ max_completion_tokens: 1024 })).toEqual({ limit: { output: 1024 } })
    expect(parseLiveMetadata({ display_name: " Local Model " })).toEqual({ name: "Local Model" })
  })
})
