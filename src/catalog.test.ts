import { describe, expect, test } from "bun:test"
import {
  discoverModelMetadata,
  discoverModels,
  normalizeBaseURL,
  parseCatalog,
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
          },
        },
      },
    })
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
