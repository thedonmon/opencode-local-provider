import type { Credential, Plugin, Provider } from "@opencode/plugin"

import {
  LOCAL_PLUGIN_ID,
  LOCAL_PLUGIN_SERVICE,
  LOCAL_PROVIDER_ID,
  LOCAL_PROVIDER_INTEGRATION_ID,
  LOCAL_PROVIDER_NAME,
  LOCAL_TARGETS_INTEGRATION_ID,
  LOCAL_TARGETS_INTEGRATION_NAME,
  V2_OPENAI_COMPATIBLE_PACKAGE,
} from "./constants"
import { getConfiguredTargets, getProviderApiKey, getProviderTargets, resolveEnv } from "./config"
import { rememberModels, type ModelCache } from "./cache"
import { buildModels } from "./models"
import { probe } from "./probe"
import { KINDS, type LocalTarget } from "./types"
import { trimURL } from "./url"

const TARGET_METHOD_ID = "target"
const CACHE_KEY = "models"
// Loaded models change as servers swap them in and out, so probe again on a
// timer as well as when a target is added or removed.
const REFRESH_INTERVAL = 60_000

const TARGET_ID_PATTERN = "^[a-z0-9][a-z0-9-_]*$"

// What "Add Custom Target" stores for a target. The target's key is the
// credential's access token, so it is kept with OpenCode's other secrets.
type TargetMetadata = {
  target: string
  url: string
  kind?: LocalTarget["kind"]
  includeUnloaded?: boolean
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

function warn(message: string) {
  console.warn(`[${LOCAL_PLUGIN_SERVICE}] ${message}`)
}

function readMetadata(value: unknown): TargetMetadata | undefined {
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.target !== "string" || typeof item.url !== "string" || !item.url) return
  return {
    target: item.target,
    url: item.url,
    ...(typeof item.kind === "string" && KINDS.includes(item.kind as LocalTarget["kind"] & string)
      ? { kind: item.kind as LocalTarget["kind"] }
      : {}),
    ...(item.includeUnloaded === true ? { includeUnloaded: true } : {}),
  }
}

export const LocalProviderPluginV2 = {
  id: LOCAL_PLUGIN_ID,
  async setup(ctx) {
    // Targets come from the plugin's own `options` in its `plugins` config
    // entry and from /connect, plus the built-in defaults unless
    // `includeDefaults` is false.
    const sharedKey = getProviderApiKey({ options: ctx.options })

    // Targets added from /connect, one credential each. Connections are
    // listed newest first, so walk them oldest first to let a re-added target
    // replace the earlier one.
    async function connectedTargets() {
      const integration = await ctx.integration.get({ integrationID: LOCAL_TARGETS_INTEGRATION_ID }).then(
        (result) => result.data,
        () => undefined,
      )
      const list: Record<string, LocalTarget> = {}
      for (const connection of [...(integration?.connections ?? [])].reverse()) {
        if (connection.type !== "credential") continue
        const value = await ctx.integration.connection.resolve(connection)
        if (value?.type !== "oauth") continue
        const meta = readMetadata(value.metadata)
        if (!meta) continue
        list[meta.target] = {
          url: meta.url,
          ...(meta.kind ? { kind: meta.kind } : {}),
          ...(value.access ? { apiKey: value.access } : {}),
          ...(meta.includeUnloaded ? { includeUnloaded: true } : {}),
        }
      }
      return list
    }

    async function probeAll() {
      // Built-in default targets are expected to be offline most of the time,
      // so only targets the user set up are worth a warning.
      const options = { ...ctx.options, targets: { ...ctx.options.targets, ...(await connectedTargets()) } }
      const configured = getConfiguredTargets({ options })
      const list = getProviderTargets({ options })

      const cache = ((await ctx.storage.get(CACHE_KEY)) ?? {}) as ModelCache
      let cacheChanged = false
      const all = await Promise.all(
        Object.entries(list).map(async ([id, item]) => {
          const apiKey = resolveEnv(item.apiKey || sharedKey)
          try {
            const found = await probe(item.url, item.kind, { ...item, apiKey })
            const remembered = rememberModels(cache, item.url, found.models)
            cacheChanged ||= remembered.changed
            return buildModels(id, item.url, remembered.models, apiKey)
          } catch (e) {
            if (configured[id]) warn(`Target "${id}" probe failed: ${errorMessage(e)}`)
            return []
          }
        }),
      )
      if (cacheChanged) await ctx.storage.set(CACHE_KEY, cache)
      return all.flat()
    }

    // Transforms must be synchronous, so they read the last probe result and
    // a refresh replaces it and asks OpenCode to replay them.
    const source = { models: await probeAll() }
    let last = JSON.stringify(source.models)
    let refreshing: Promise<void> | undefined
    function refresh() {
      refreshing ??= probeAll()
        .then(async (models) => {
          const next = JSON.stringify(models)
          if (next === last) return
          last = next
          source.models = models
          await ctx.provider.reload()
        })
        .catch((e) => warn(`Refresh failed: ${errorMessage(e)}`))
        .finally(() => {
          refreshing = undefined
        })
      return refreshing
    }

    await ctx.provider.transform((editor) => {
      // A `providers.local` block in config can create the provider first.
      if (editor.get(LOCAL_PROVIDER_ID)) {
        editor.update(LOCAL_PROVIDER_ID, (provider) => {
          provider.activation = "enabled"
          provider.package ||= V2_OPENAI_COMPATIBLE_PACKAGE
          Object.assign(provider, { integrationID: LOCAL_PROVIDER_INTEGRATION_ID })
        })
        editor.models.set(LOCAL_PROVIDER_ID, source.models)
        return
      }
      editor.add({
        info: {
          id: LOCAL_PROVIDER_ID,
          name: LOCAL_PROVIDER_NAME,
          activation: "enabled",
          package: V2_OPENAI_COMPATIBLE_PACKAGE,
          integrationID: LOCAL_PROVIDER_INTEGRATION_ID,
        } as Provider.Info,
        models: source.models,
      })
    })

    await ctx.integration.transform((editor) => {
      editor.update(LOCAL_TARGETS_INTEGRATION_ID, (integration) => {
        integration.name = LOCAL_TARGETS_INTEGRATION_NAME
      })
      editor.method.update({
        integrationID: LOCAL_TARGETS_INTEGRATION_ID,
        method: {
          id: TARGET_METHOD_ID,
          type: "oauth",
          label: "Add Custom Target",
          form: [
            {
              key: "target",
              type: "string",
              title: "Target ID",
              description: "Lowercase letters, numbers, - or _",
              placeholder: "studio",
              pattern: TARGET_ID_PATTERN,
              required: true,
            },
            {
              key: "baseURL",
              type: "string",
              title: "Server URL",
              placeholder: "http://192.168.1.10:1234",
              required: true,
            },
            {
              key: "apiKey",
              type: "string",
              title: "API key",
              description: "Leave empty if the server has none, or use {env:VAR} to read it from the environment",
              placeholder: "no key",
            },
            {
              key: "models",
              type: "string",
              title: "Which models should be listed?",
              default: "loaded",
              options: [
                { label: "Loaded models only", value: "loaded" },
                {
                  label: "All models the server offers",
                  value: "all",
                  description: "llama-swap loads them on demand",
                },
              ],
            },
          ],
        },
        // Probe before saving so a wrong URL or key fails right away. The
        // credential holds the target itself; nothing is opened in a browser.
        async authorize(answer) {
          const id = typeof answer.target === "string" ? answer.target.trim() : ""
          const url = trimURL(typeof answer.baseURL === "string" ? answer.baseURL : "")
          const entered = typeof answer.apiKey === "string" ? answer.apiKey.trim() : ""
          const apiKey = entered.toLowerCase() === "none" ? "" : entered
          const includeUnloaded = answer.models === "all"

          if (!new RegExp(TARGET_ID_PATTERN).test(id)) {
            throw new Error("Target ID must use lowercase letters, numbers, - or _")
          }
          if (!url) throw new Error("URL is required")
          const found = await probe(url, undefined, { apiKey: resolveEnv(apiKey), includeUnloaded })
          const metadata: TargetMetadata = { target: id, url, kind: found.kind, includeUnloaded }

          return {
            url: "",
            instructions: `Found ${found.kind} at ${url}. Saving target "${id}".`,
            mode: "auto",
            callback: Promise.resolve({
              type: "oauth",
              methodID: TARGET_METHOD_ID,
              access: apiKey,
              refresh: "",
              expires: 0,
              metadata,
            } as unknown as Credential.OAuth),
          }
        },
        label: (credential) => readMetadata(credential.metadata)?.target,
      })
    })

    const abort = new AbortController()
    const timer = setInterval(refresh, REFRESH_INTERVAL)
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (event.type === "credential.updated") void refresh()
        }
      } catch (e) {
        if (!abort.signal.aborted) warn(`Event stream stopped: ${errorMessage(e)}`)
      }
    })()

    return () => {
      clearInterval(timer)
      abort.abort()
    }
  },
} satisfies Plugin.Plugin

