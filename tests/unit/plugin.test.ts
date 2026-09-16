import { describe, expect, mock, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"

import { saveProviderTarget } from "../../src/config"
import { LocalProviderPlugin } from "../../src/plugin"

function fakeClient(fetchImpl?: typeof fetch) {
  const logs: { level: string; message: string }[] = []
  const client = {
    app: {
      log: async ({ body }: { body: { level: string; message: string } }) => {
        logs.push(body)
      },
    },
    _client: { getConfig: () => ({ fetch: fetchImpl }) },
  }
  return { client: client as unknown as PluginInput["client"], logs }
}

function swapServer(key: string) {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${key}`) {
      return new Response(null, { status: 401 })
    }
    if (url === "https://swap.example.com/v1/models") {
      return Response.json({
        data: [{ id: "qwen", owned_by: "llama-swap", name: "Qwen", context_length: 65536 }],
      })
    }
    if (url === "https://swap.example.com/running") return Response.json({ running: [] })
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
}

describe("config hook", () => {
  test("probes keyed targets and sends the key with their models", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = swapServer("secret")
    const { client } = fakeClient()

    try {
      const hooks = await LocalProviderPlugin({ client, serverUrl: new URL("http://opencode.test") } as PluginInput)
      const cfg: Config = {
        provider: {
          local: {
            options: {
              includeDefaults: false,
              targets: {
                swap: { url: "https://swap.example.com", apiKey: "secret", includeUnloaded: true },
              },
            },
          },
        },
      }

      await hooks.config!(cfg)

      const model = cfg.provider!.local!.models!["swap/qwen"]!
      expect(model.name).toBe("Qwen (swap)")
      expect(model.limit).toEqual({ context: 65536, output: 8192 })
      expect(model.headers).toEqual({ Authorization: "Bearer secret" })
      // `provider.api` is read by OpenCode at runtime but missing from the SDK config type.
      expect(model.provider as unknown).toEqual({ npm: "@ai-sdk/openai-compatible", api: "https://swap.example.com/v1" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to the provider-wide apiKey for probing", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = swapServer("shared")
    const { client } = fakeClient()

    try {
      const hooks = await LocalProviderPlugin({ client, serverUrl: new URL("http://opencode.test") } as PluginInput)
      const cfg: Config = {
        provider: {
          local: {
            options: {
              apiKey: "shared",
              includeDefaults: false,
              targets: { swap: { url: "https://swap.example.com", includeUnloaded: true } },
            },
          },
        },
      }

      await hooks.config!(cfg)

      // OpenAI-compatible SDKs send options.apiKey themselves.
      expect(cfg.provider!.local!.models!["swap/qwen"]!.headers).toEqual({})
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("logs probe failures for configured targets only", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = swapServer("secret")
    const { client, logs } = fakeClient()

    try {
      const hooks = await LocalProviderPlugin({ client, serverUrl: new URL("http://opencode.test") } as PluginInput)
      const cfg: Config = {
        provider: {
          local: {
            options: { targets: { swap: { url: "https://swap.example.com", apiKey: "wrong" } } },
          },
        },
      }

      await hooks.config!(cfg)

      expect(cfg.provider!.local!.models).toEqual({})
      expect(logs.filter((item) => item.level === "warn").map((item) => item.message)).toEqual([
        'Target "swap" probe failed: https://swap.example.com/v1 rejected the request (HTTP 401), check the target\'s API key',
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("saveProviderTarget", () => {
  test("patches only the new target into global config", async () => {
    const bodies: unknown[] = []
    const fetchImpl = mock(async (input: string | URL | Request) => {
      const request = input as Request
      bodies.push(await request.json())
      return Response.json({})
    }) as unknown as typeof fetch
    const { client } = fakeClient(fetchImpl)

    await saveProviderTarget(new URL("http://opencode.test"), client, "swap", {
      url: "https://swap.example.com",
      kind: "llamaswap",
      apiKey: "{env:SWAP_KEY}",
    })

    expect(bodies).toEqual([
      {
        provider: {
          local: {
            options: {
              targets: {
                swap: {
                  url: "https://swap.example.com/v1",
                  kind: "llamaswap",
                  apiKey: "{env:SWAP_KEY}",
                  includeUnloaded: false,
                },
              },
            },
          },
        },
      },
    ])
  })
})

describe("Add Custom Target", () => {
  function configRecorder() {
    const bodies: any[] = []
    const fetchImpl = mock(async (input: string | URL | Request) => {
      bodies.push(await (input as Request).json())
      return Response.json({})
    }) as unknown as typeof fetch
    return { bodies, fetchImpl }
  }

  async function addTarget(fetchImpl: typeof fetch, inputs: Record<string, string>) {
    const { client, logs } = fakeClient(fetchImpl)
    const hooks = await LocalProviderPlugin({ client, serverUrl: new URL("http://opencode.test") } as PluginInput)
    const method = hooks.auth!.methods[0]!
    if (method.type !== "oauth") throw new Error("expected an oauth method")
    return { method, logs, run: () => method.authorize(inputs) }
  }

  test("saves a keyed target only once the login completes", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = swapServer("secret")
    process.env.TEST_SWAP_KEY = "secret"
    const { bodies, fetchImpl } = configRecorder()

    try {
      const { run } = await addTarget(fetchImpl, {
        target: "swap",
        baseURL: "https://swap.example.com/",
        apiKey: "{env:TEST_SWAP_KEY}",
        models: "all",
      })
      const authorization = await run()

      expect(authorization.method).toBe("auto")
      expect(bodies).toEqual([])
      if (authorization.method !== "auto") return

      expect(await authorization.callback()).toEqual({ type: "success", provider: "local", key: "" })
      expect(bodies).toEqual([
        {
          provider: {
            local: {
              options: {
                targets: {
                  swap: {
                    url: "https://swap.example.com/v1",
                    kind: "llamaswap",
                    apiKey: "{env:TEST_SWAP_KEY}",
                    includeUnloaded: true,
                  },
                },
              },
            },
          },
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.TEST_SWAP_KEY
    }
  })

  test("saves keyless targets without an apiKey", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "http://studio.test/v1/models") return Response.json({ data: [{ id: "qwen" }] })
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    const { bodies, fetchImpl } = configRecorder()

    try {
      const { run } = await addTarget(fetchImpl, {
        target: "studio",
        baseURL: "http://studio.test",
        apiKey: "",
        models: "loaded",
      })
      const authorization = await run()
      if (authorization.method !== "auto") throw new Error("expected auto")
      await authorization.callback()

      expect(bodies[0].provider.local.options.targets).toEqual({
        studio: { url: "http://studio.test/v1", kind: "openai", includeUnloaded: false },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fails before saving when the server rejects the key", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = swapServer("secret")
    const { bodies, fetchImpl } = configRecorder()

    try {
      const { run, logs } = await addTarget(fetchImpl, {
        target: "swap",
        baseURL: "https://swap.example.com",
        apiKey: "wrong",
        models: "loaded",
      })

      await expect(run()).rejects.toThrow("rejected the request (HTTP 401)")
      expect(bodies).toEqual([])
      expect(logs.some((item) => item.level === "error" && item.message.includes("HTTP 401"))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects invalid target IDs", async () => {
    const { fetchImpl } = configRecorder()
    const { run } = await addTarget(fetchImpl, { target: "My Server", baseURL: "http://studio.test" })
    await expect(run()).rejects.toThrow("Target ID must use lowercase letters")
  })
})
