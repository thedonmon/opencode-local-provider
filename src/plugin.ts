import type { Plugin } from "@opencode-ai/plugin"
import type { Provider } from "@opencode-ai/sdk/v2"
import pkg from "../package.json" with { type: "json" }

import {
  LOCAL_PROVIDER_ID,
  LOCAL_PROVIDER_NAME,
  LOCAL_PLUGIN_SERVICE,
  OPENAI_COMPATIBLE_NPM,
} from "./constants"
import {
  getConfiguredTargets,
  getProviderApiKey,
  getProviderTargets,
  resolveEnv,
  saveProviderTarget,
} from "./config"
import { loadModelCache, rememberModels, saveModelCache } from "./cache"
import { buildConfig } from "./models"
import { supportedProviderKinds } from "./providers"
import { probe } from "./probe"
import type { LocalTarget } from "./types"
import { trimURL } from "./url"

function validID(value: string) {
  return /^[a-z0-9][a-z0-9-_]*$/.test(value)
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

async function probeModels(
  provider?: Pick<Provider, "options" | "models">,
  onError?: (target: string, e: unknown) => Promise<void>,
) {
  const list = getProviderTargets(provider)
  if (!Object.keys(list).length) return {}
  const sharedKey = getProviderApiKey(provider)
  const cache = await loadModelCache()
  let cacheChanged = false

  const all = await Promise.all(
    Object.entries(list).map(async ([id, item]) => {
      try {
        const found = await probe(item.url, item.kind, { ...item, apiKey: item.apiKey || sharedKey })
        const remembered = rememberModels(cache, item.url, found.models)
        cacheChanged ||= remembered.changed
        // OpenAI-compatible SDKs already send the provider-wide key, so only a
        // target's own key needs to be added to its models.
        return buildConfig(id, item.url, remembered.models, (provider?.models ?? {}) as Record<string, never>, item.apiKey)
      } catch (e) {
        await onError?.(id, e)
        return {}
      }
    }),
  )

  if (cacheChanged) await saveModelCache(cache)
  return Object.assign({}, ...all)
}

export const LocalProviderPlugin: Plugin = async (ctx) => {
  const log = (level: "info" | "warn" | "error", message: string) =>
    ctx.client.app.log({
      body: {
        service: LOCAL_PLUGIN_SERVICE,
        level,
        message,
      },
    })

  await log("info", `Local Provider plugin loaded v${pkg.version}. Supported backends: ${supportedProviderKinds.join(", ")}`)

  return {
    config: async (cfg) => {
      const provider = cfg.provider?.[LOCAL_PROVIDER_ID] ?? {}
      const list = getConfiguredTargets(provider as Provider)
      const options = {
        ...provider.options,
        includeDefaults: provider.options?.includeDefaults ?? true,
        targets: list,
      }
      delete options.baseURL
      // OpenCode can share nested config objects with its cached global
      // config, so replace `provider` rather than writing into it. Otherwise
      // the next instance would read these generated models back as the
      // user's own model settings.
      cfg.provider = { ...cfg.provider }
      cfg.provider[LOCAL_PROVIDER_ID] = {
        ...provider,
        name: provider.name ?? LOCAL_PROVIDER_NAME,
        npm: provider.npm ?? OPENAI_COMPATIBLE_NPM,
        options,
        models: await probeModels(
          {
            options,
            models: (provider as Provider).models,
          },
          async (target, e) => {
            // Built-in default targets are expected to be offline most of the time.
            if (!list[target]) return
            await log("warn", `Target "${target}" probe failed: ${errorMessage(e)}`)
          },
        ),
      }
    },
    auth: {
      provider: LOCAL_PROVIDER_ID,
      methods: [
        {
          // "oauth" is the only method type OpenCode passes to the plugin from
          // both /connect and `opencode auth login`. /connect saves an "api"
          // method's answers without calling the plugin, and the CLI adds an
          // API key prompt the plugin never sees. "auto" finishes without a
          // browser step.
          type: "oauth",
          label: "Add Custom Target",
          prompts: [
            {
              type: "text",
              key: "target",
              message: "Enter a target ID",
              placeholder: "studio",
              validate(value) {
                if (!value) return "Target ID is required"
                if (!validID(value)) return "Use lowercase letters, numbers, - or _"
              },
            },
            {
              type: "text",
              key: "baseURL",
              message: "Enter the server URL",
              placeholder: "http://192.168.1.10:1234",
              validate(value) {
                if (!trimURL(value ?? "")) return "URL is required"
              },
            },
            {
              type: "text",
              key: "apiKey",
              message: "Enter the server's API key, or {env:VAR} to read it from the environment. Leave empty if it has none",
              placeholder: "no key",
            },
            {
              type: "select",
              key: "models",
              message: "Which models should be listed?",
              options: [
                { label: "Loaded models only", value: "loaded" },
                { label: "All models the server offers", value: "all", hint: "llama-swap loads them on demand" },
              ],
            },
          ],
          async authorize(input = {}) {
            const id = input.target?.trim() ?? ""
            const url = trimURL(input.baseURL ?? "")
            const entered = input.apiKey?.trim() ?? ""
            const apiKey = entered.toLowerCase() === "none" ? "" : entered
            const includeUnloaded = input.models === "all"

            let target: LocalTarget
            try {
              if (!validID(id)) throw new Error("Target ID must use lowercase letters, numbers, - or _")
              if (!url) throw new Error("URL is required")
              // Probe before saving so a wrong URL or key fails right away.
              const found = await probe(url, undefined, { apiKey: resolveEnv(apiKey), includeUnloaded })
              target = { url, kind: found.kind, apiKey, includeUnloaded }
            } catch (e) {
              await log("error", `Add Custom Target failed: ${errorMessage(e)}`)
              throw e
            }

            return {
              url: "",
              method: "auto" as const,
              instructions: `Found ${target.kind} at ${url}. Saving target "${id}".`,
              // Saving config restarts OpenCode's instances. Doing it here
              // rather than in authorize() keeps /connect's pending login
              // alive until this callback has been looked up.
              async callback() {
                try {
                  await saveProviderTarget(ctx.serverUrl, ctx.client, id, target)
                  return { type: "success" as const, provider: LOCAL_PROVIDER_ID, key: "" }
                } catch (e) {
                  await log("error", `Saving target "${id}" failed: ${errorMessage(e)}`)
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
      ],
    },
  }
}
