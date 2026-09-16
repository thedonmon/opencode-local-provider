import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { Provider } from "@opencode-ai/sdk/v2"

import { LEGACY_TARGET_ID, LOCAL_PROVIDER_ID } from "./constants"
import { supportedProviderDefaultURLs } from "./providers"
import { KINDS, type LocalTarget } from "./types"
import { baseURL } from "./url"

type HarnessClientConfig = {
  fetch?: typeof fetch
  headers?: Record<string, string>
}

function getV1OpencodeClientConfig(input: PluginInput["client"]): HarnessClientConfig {
  return (((input as unknown) as {
    _client?: { getConfig?: () => HarnessClientConfig }
  })._client?.getConfig?.() ?? {}) as HarnessClientConfig
}

// The plugin harness already gives us a configured v1 client. Reuse that
// fetch implementation and headers when creating the v2 client so config
// requests keep the same transport/auth behavior.
function createV2OpencodeClient(url: URL, input: PluginInput["client"]) {
  const v1ClientConfig = getV1OpencodeClientConfig(input)

  return createOpencodeClient({
    baseUrl: url.toString(),
    fetch: v1ClientConfig.fetch,
    headers: v1ClientConfig.headers,
    throwOnError: true,
  })
}

function parseTargetConfig(item: unknown) {
  if (typeof item === "string" && item) return { url: baseURL(item) }
  if (item && typeof item === "object") {
    const url = "url" in item ? item.url : undefined
    const kind = "kind" in item ? item.kind : undefined
    const apiKey = "apiKey" in item ? item.apiKey : undefined
    const includeUnloaded = "includeUnloaded" in item ? item.includeUnloaded : undefined
    if (typeof url === "string" && url) {
      return {
        url: baseURL(url),
        ...(typeof kind === "string" && KINDS.includes(kind as (typeof KINDS)[number]) ? { kind } : {}),
        ...(typeof apiKey === "string" && apiKey ? { apiKey } : {}),
        ...(includeUnloaded === true ? { includeUnloaded } : {}),
      }
    }
  }
}

const defaults = Object.fromEntries(
  Object.entries(supportedProviderDefaultURLs).map(([id, url]) => [
    id,
    {
      url: baseURL(url!),
      kind: id as LocalTarget["kind"],
    },
  ]),
) as Record<string, LocalTarget>

export function getConfiguredTargets(provider?: Pick<Provider, "options">) {
  const raw = provider?.options?.targets
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const next = Object.fromEntries(
      Object.entries(raw)
        .map(([id, item]) => {
          const val = parseTargetConfig(item)
          if (!val) return
          return [id, val] as const
        })
        .filter((item): item is readonly [string, LocalTarget] => Boolean(item)),
    )
    if (Object.keys(next).length) return next
  }

  const url = provider?.options?.baseURL
  if (typeof url === "string" && url) {
    return {
      [LEGACY_TARGET_ID]: {
        url: baseURL(url),
      },
    }
  }

  return {}
}

export function getProviderTargets(provider?: Pick<Provider, "options">) {
  const configured = getConfiguredTargets(provider)
  if (provider?.options?.includeDefaults === false) return configured

  const urls = new Set(Object.values(configured).map((item) => item.url))
  const builtin = Object.fromEntries(
    Object.entries(defaults).filter(([id, item]) => !configured[id] && !urls.has(item.url)),
  ) as Record<string, LocalTarget>

  return {
    ...builtin,
    ...configured,
  }
}

// A provider-wide `options.apiKey` is what OpenCode itself sends to every
// model of the provider, so probes fall back to it when a target has no key.
export function getProviderApiKey(provider?: Pick<Provider, "options">) {
  const val = provider?.options?.apiKey
  return typeof val === "string" ? val : ""
}

// Resolve `{env:VAR}` the same way OpenCode does when it loads config, for
// values that have not been through config loading yet (CLI prompt input).
export function resolveEnv(value: string) {
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] || "")
}

export async function saveProviderTarget(
  server: URL,
  input: PluginInput["client"],
  id: string,
  target: LocalTarget,
) {
  // The global config update deep-merges into the config file, so only the
  // new target is sent. Re-sending the others would replace any `{env:VAR}`
  // references in them with the resolved values.
  await createV2OpencodeClient(server, input).global.config.update({
    config: {
      provider: {
        [LOCAL_PROVIDER_ID]: {
          options: {
            targets: {
              [id]: {
                url: baseURL(target.url),
                ...(target.kind ? { kind: target.kind } : {}),
                ...(target.apiKey ? { apiKey: target.apiKey } : {}),
                includeUnloaded: target.includeUnloaded === true,
              },
            },
          },
        },
      },
    },
  })
}
