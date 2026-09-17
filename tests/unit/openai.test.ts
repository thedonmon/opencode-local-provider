import { describe, expect, mock, test } from "bun:test"

import { probe } from "../../src/probe"
import { isChatModel, modelFromListing } from "../../src/providers/openai"

function mockFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return mock(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    if (url in routes) return Response.json(routes[url])
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
}

describe("OpenAI-compatible model listing", () => {
  test("reads llama-swap style metadata", () => {
    expect(
      modelFromListing({
        id: "qwen",
        name: "Qwen 3.6",
        context_length: 65536,
        capabilities: { vision: true, function_calling: true },
        supported_parameters: ["tools", "tool_choice"],
        architecture: { input_modalities: ["text", "image"] },
      }),
    ).toEqual({ id: "qwen", name: "Qwen 3.6", context: 65536, toolcall: true, vision: true })
  })

  test("reads list capabilities and nested context fields", () => {
    expect(
      modelFromListing({
        id: "gemma",
        capabilities: ["tools"],
        meta: { n_ctx_train: 8192 },
      }),
    ).toEqual({ id: "gemma", context: 8192, toolcall: true, vision: false })
    expect(modelFromListing({ id: "vllm-model", max_model_len: 4096 }).context).toBe(4096)
  })

  test("ignores null or malformed metadata", () => {
    expect(
      modelFromListing({
        id: "plain",
        name: null,
        context_length: null,
        capabilities: "tools",
        meta: null,
      }),
    ).toEqual({ id: "plain", context: 0, toolcall: false, vision: false })
  })

  test("only keeps models that chat in text", () => {
    expect(isChatModel({ id: "plain" })).toBe(true)
    expect(isChatModel({ id: "vl", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } })).toBe(true)
    expect(isChatModel({ id: "whisper", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } })).toBe(false)
    expect(isChatModel({ id: "tts", architecture: { input_modalities: ["text"], output_modalities: ["audio"] } })).toBe(false)
    expect(isChatModel({ id: "rerank", capabilities: { reranker: true } })).toBe(false)
    expect(isChatModel({ id: "embed", capabilities: ["embedding"] })).toBe(false)
  })
})

describe("OpenAI-compatible fallback", () => {
  test("detects servers that only expose /v1/models", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch({
      "http://proxy.test/v1/models": {
        object: "list",
        data: [{ id: "gpt-oss", object: "model", owned_by: "someone", context_window: 131072 }],
      },
    })

    try {
      const result = await probe("http://proxy.test/v1")
      expect(result.kind).toBe("openai")
      expect(result.models).toEqual([{ id: "gpt-oss", context: 131072, toolcall: false, vision: false }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("explicit openai kind skips backend detection", async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch(
      {
        "http://llamaswap.test/v1/models": { data: [{ id: "idle", owned_by: "llama-swap" }] },
      },
      calls,
    )

    try {
      const result = await probe("http://llamaswap.test", "openai")
      expect(result.kind).toBe("openai")
      expect(result.models.map((item) => item.id)).toEqual(["idle"])
      expect(calls.every((url) => url === "http://llamaswap.test/v1/models")).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("still rejects servers without a model listing", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch({})

    try {
      await expect(probe("http://nothing.test")).rejects.toThrow("No supported local provider detected")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
