import { describe, expect, mock, test } from "bun:test"

import { runningModels } from "../../src/providers/llamaswap"
import { probe } from "../../src/probe"

describe("llama-swap provider", () => {
  test("only probes upstream for loaded models", async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)

      if (url === "http://llamaswap.test/v1/models") {
        return new Response(
          JSON.stringify({
            data: [
              { id: "loaded", owned_by: "llama-swap" },
              { id: "idle", owned_by: "llama-swap" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      if (url === "http://llamaswap.test/running") {
        return new Response(
          JSON.stringify({
            running: [{ model: "loaded", state: "ready" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      if (url === "http://llamaswap.test/upstream/loaded/props") {
        return new Response(
          JSON.stringify({
            default_generation_settings: { n_ctx: 4096 },
            modalities: { vision: true, audio: false },
            chat_template_caps: { supports_tools: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }

      if (url === "http://llamaswap.test/upstream/loaded/slots") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`)
    }) as typeof fetch

    try {
      const result = await probe("http://llamaswap.test")

      expect(await runningModels("http://llamaswap.test")).toEqual(new Set(["loaded"]))
      expect(result.kind).toBe("llamaswap")
      expect(result.models).toEqual([
        { id: "loaded", context: 4096, toolcall: true, vision: true, live: true },
      ])
      expect(calls).toContain("http://llamaswap.test/upstream/loaded/props")
      expect(calls).not.toContain("http://llamaswap.test/upstream/idle/props")
      expect(calls).not.toContain("http://llamaswap.test/upstream/idle/slots")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("lists unloaded chat models from /v1/models without loading them", async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)

      if (url === "http://llamaswap.test/v1/models") {
        return Response.json({
          data: [
            { id: "loaded", owned_by: "llama-swap", context_length: 4096 },
            {
              id: "whisper",
              owned_by: "llama-swap",
              architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
              capabilities: { audio_transcriptions: true },
            },
            {
              id: "idle",
              owned_by: "llama-swap",
              name: "Idle Model",
              context_length: 32768,
              capabilities: { vision: true, function_calling: true },
              supported_parameters: ["tools", "tool_choice"],
            },
          ],
        })
      }

      if (url === "http://llamaswap.test/running") {
        return Response.json({ running: [{ model: "loaded", state: "ready" }] })
      }

      if (url === "http://llamaswap.test/upstream/loaded/props") {
        return Response.json({ default_generation_settings: { n_ctx: 2048 } })
      }

      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    try {
      const result = await probe("http://llamaswap.test", "llamaswap", { includeUnloaded: true })

      expect(result.models).toEqual([
        { id: "loaded", context: 2048, toolcall: false, vision: false, live: true },
        { id: "idle", name: "Idle Model", context: 32768, toolcall: true, vision: true },
      ])
      expect(calls.some((url) => url.includes("/upstream/idle"))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("sends the target API key on every probe request", async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)

      if (new Headers(init?.headers).get("Authorization") !== "Bearer secret") {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
      }

      if (url === "http://llamaswap.test/v1/models") {
        return Response.json({ data: [{ id: "loaded", owned_by: "llama-swap" }] })
      }

      if (url === "http://llamaswap.test/running") {
        return Response.json({ running: [{ model: "loaded", state: "ready" }] })
      }

      if (url === "http://llamaswap.test/upstream/loaded/props") {
        return Response.json({ default_generation_settings: { n_ctx: 8192 } })
      }

      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    try {
      await expect(probe("http://llamaswap.test")).rejects.toThrow(
        "http://llamaswap.test rejected the request (HTTP 401), check the target's API key",
      )

      const result = await probe("http://llamaswap.test", "llamaswap", { apiKey: "secret" })

      expect(result.kind).toBe("llamaswap")
      expect(result.models).toEqual([
        { id: "loaded", context: 8192, toolcall: false, vision: false, live: true },
      ])
      expect(calls).toContain("http://llamaswap.test/running")
      expect(calls).toContain("http://llamaswap.test/upstream/loaded/props")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
