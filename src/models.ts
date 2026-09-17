import type { Model } from "@opencode-ai/sdk/v2"

import { DEFAULT_CONTEXT, MAX_OUTPUT, OPENAI_COMPATIBLE_NPM } from "./constants"
import type { LocalModel } from "./types"
import { authHeaders, baseURL } from "./url"

type Modality = "text" | "audio" | "image" | "video" | "pdf"

// A model entry from the user's `provider.local.models` config. Every field
// set there wins over what the probe found.
type ConfigModel = {
  id?: string
  name?: string
  attachment?: boolean
  tool_call?: boolean
  limit?: { context: number; input?: number; output: number }
  modalities?: { input?: Modality[]; output?: Modality[] }
  options?: Record<string, unknown>
  headers?: Record<string, string>
  provider?: {
    npm?: string
  }
  [key: string]: unknown
}

function limits(input: number) {
  const context = input > 0 ? input : DEFAULT_CONTEXT
  // A quarter of the context leaves room for long answers and reasoning while
  // keeping most of it for the conversation.
  return {
    context,
    output: Math.min(MAX_OUTPUT, Math.floor(context / 4)),
  }
}

function id(target: string, model: string) {
  return `${target}/${model}`
}

function name(target: string, model: LocalModel) {
  return `${model.name ?? model.id} (${target})`
}

function modalities(model: LocalModel): { input: Modality[]; output: Modality[] } {
  return {
    input: ["text", ...(model.vision ? (["image"] as const) : [])],
    output: ["text"],
  }
}

function item(providerID: string, target: string, url: string, model: LocalModel, prev?: Model): Model {
  const attach = model.vision || prev?.capabilities.attachment || false
  const limit = limits(model.context)
  const next = id(target, model.id)

  return {
    id: next,
    providerID,
    api: {
      id: model.id,
      url: baseURL(url),
      npm: prev?.api.npm ?? OPENAI_COMPATIBLE_NPM,
    },
    name: prev?.name ?? name(target, model),
    family: prev?.family ?? "",
    capabilities: {
      temperature: prev?.capabilities.temperature ?? true,
      reasoning: prev?.capabilities.reasoning ?? false,
      attachment: attach,
      toolcall: model.toolcall,
      input: {
        text: true,
        audio: false,
        image: model.vision,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: prev?.capabilities.interleaved ?? false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit,
    status: prev?.status ?? "active",
    options: {
      ...prev?.options,
      target,
    },
    headers: prev?.headers ?? {},
    release_date: prev?.release_date ?? "",
    variants: prev?.variants ?? {},
  }
}

function configItem(target: string, url: string, model: LocalModel, prev: ConfigModel = {}, apiKey?: string) {
  const probed = modalities(model)
  const input = prev.modalities?.input ?? probed.input
  return {
    name: name(target, model),
    temperature: true,
    ...(model.toolcall ? { tool_call: true } : {}),
    cost: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
    limit: limits(model.context),
    ...prev,
    id: prev.id ?? model.id,
    attachment: prev.attachment ?? input.includes("image"),
    modalities: {
      input,
      output: prev.modalities?.output ?? probed.output,
    },
    options: {
      ...prev.options,
      target,
    },
    // OpenAI-compatible SDKs send model headers on every request, which is how
    // each target gets its own key under the single `local` provider. The
    // target key goes last so a header injected by an earlier run can't
    // outlive a key change.
    headers: {
      ...prev.headers,
      ...authHeaders(apiKey),
    },
    provider: {
      npm: prev.provider?.npm ?? OPENAI_COMPATIBLE_NPM,
      api: baseURL(url),
    },
  }
}

export function build(providerID: string, target: string, url: string, list: LocalModel[], prev: Record<string, Model>) {
  return Object.fromEntries(
    list.map((model) => {
      const key = id(target, model.id)
      return [key, item(providerID, target, url, model, prev[key])]
    }),
  )
}

export function buildConfig(
  target: string,
  url: string,
  list: LocalModel[],
  prev: Record<string, ConfigModel>,
  apiKey?: string,
) {
  return Object.fromEntries(
    list.map((model) => {
      const key = id(target, model.id)
      return [key, configItem(target, url, model, prev[key], apiKey)]
    }),
  )
}
