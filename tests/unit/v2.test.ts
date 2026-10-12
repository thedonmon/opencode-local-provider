import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"

import { LocalProviderPluginV2 } from "../../src/v2"

type Added = { info: { id: string; package: string }; models: { id: string; modelID: string; settings?: Record<string, unknown> }[] }
type OAuthRegistration = {
  method: { id: string; type: string }
  authorize: (answer: Record<string, unknown>) => Promise<{ mode: string; callback: Promise<unknown> }>
  label?: (credential: unknown) => string | undefined
}

// A server with one model that only answers requests carrying `key`.
function keyedServer(origin: string, key: string) {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith(origin)) return new Response(null, { status: 404 })
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${key}`) return new Response(null, { status: 401 })
    if (url === `${origin}/v1/models`) return Response.json({ object: "list", data: [{ id: "qwen", object: "model" }] })
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
}

// Just enough of the v2 host for setup: transforms run against recording
// editors, and saved credentials come back as the integration's connections.
async function start(options: Record<string, unknown>, credentials: unknown[] = []) {
  const added: Added[] = []
  const oauth: OAuthRegistration[] = []
  const store = new Map<string, unknown>()
  const ctx = {
    options,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
    provider: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({ get: () => undefined, add: (input: Added) => added.push(input) })
      },
      reload: async () => {},
    },
    integration: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({
          update: () => {},
          method: { update: (input: OAuthRegistration) => oauth.push(input) },
        })
      },
      get: async () => ({
        data: { connections: credentials.map((_, i) => ({ type: "credential", id: String(i), method: "oauth" })) },
      }),
      connection: { resolve: async (connection: { id: string }) => credentials[Number(connection.id)] },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => signal.addEventListener("abort", resolve))
        },
      }),
    },
  } as unknown as Plugin.Context
  const cleanup = (await LocalProviderPluginV2.setup(ctx)) as () => void
  return { added, oauth, cleanup }
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("v2 plugin", () => {
  test("gives each model its own target's URL and key", async () => {
    globalThis.fetch = keyedServer("https://box.example.com", "secret")
    const { added, cleanup } = await start({
      includeDefaults: false,
      targets: { box: { url: "https://box.example.com", apiKey: "secret" } },
    })
    cleanup()

    expect(added).toHaveLength(1)
    expect(added[0]!.info.id).toBe("local")
    expect(added[0]!.models.map((model) => [model.id, model.modelID, model.settings])).toEqual([
      ["box/qwen", "qwen", { baseURL: "https://box.example.com/v1", apiKey: "secret" }],
    ])
  })

  test("a target added from /connect is listed after it is saved", async () => {
    globalThis.fetch = keyedServer("https://studio.example.com", "studio-key")
    const first = await start({ includeDefaults: false })
    first.cleanup()
    const method = first.oauth.find((item) => item.method.type === "oauth")!

    await expect(
      method.authorize({ target: "studio", baseURL: "https://studio.example.com", apiKey: "wrong" }),
    ).rejects.toThrow("HTTP 401")

    const authorization = await method.authorize({
      target: "studio",
      baseURL: "https://studio.example.com/",
      apiKey: "studio-key",
      models: "loaded",
    })
    expect(authorization.mode).toBe("auto")
    const credential = await authorization.callback
    expect(method.label?.(credential)).toBe("studio")

    // Once saved, the credential comes back as one of the integration's connections.
    const next = await start({ includeDefaults: false }, [credential])
    next.cleanup()
    expect(next.added[0]!.models.map((model) => [model.id, model.settings])).toEqual([
      ["studio/qwen", { baseURL: "https://studio.example.com/v1", apiKey: "studio-key" }],
    ])
  })
})
