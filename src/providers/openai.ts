import { z } from "zod"
import type { LocalModel } from "../types"
import type { ProviderImpl } from "./shared"

// Servers disagree on where (and whether) they put model metadata in
// /v1/models, so only `id` is required and everything else is read leniently.
const ModelItemSchema = z.object({
  id: z.string(),
  owned_by: z.unknown().optional(),
  name: z.unknown().optional(),
  context_length: z.unknown().optional(),
  context_window: z.unknown().optional(),
  max_context_length: z.unknown().optional(),
  max_model_len: z.unknown().optional(),
  capabilities: z.unknown().optional(),
  supported_parameters: z.unknown().optional(),
  architecture: z.unknown().optional(),
  meta: z.unknown().optional(),
})

export const ModelsResponseSchema = z.object({
  data: z.array(ModelItemSchema),
})

export type ModelItem = z.infer<typeof ModelItemSchema>

function number(value: unknown) {
  return typeof value === "number" && value > 0 ? value : undefined
}

function field(value: unknown, key: string) {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

// Capabilities come as a list (["tools", "vision"]) or a flag map ({ vision: true }).
function capabilityList(value: unknown) {
  if (Array.isArray(value)) return strings(value)
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => key)
  }
  return []
}

export function modelFromListing(item: ModelItem): LocalModel {
  const capabilities = capabilityList(item.capabilities)
  const name = typeof item.name === "string" ? item.name.trim() : ""
  return {
    id: item.id,
    ...(name && name !== item.id ? { name } : {}),
    context:
      number(item.context_length) ??
      number(item.context_window) ??
      number(item.max_context_length) ??
      number(item.max_model_len) ??
      number(field(item.meta, "n_ctx")) ??
      number(field(item.meta, "n_ctx_train")) ??
      0,
    toolcall:
      capabilities.some((item) => ["tools", "tool_use", "function_calling"].includes(item)) ||
      strings(item.supported_parameters).includes("tools"),
    vision:
      capabilities.includes("vision") ||
      strings(field(item.architecture, "input_modalities")).includes("image"),
  }
}

// Speech, image, reranker and embedding models show up in /v1/models too, but
// OpenCode can only chat with models that take and return text. Models that
// don't describe themselves are kept.
export function isChatModel(item: ModelItem) {
  if (capabilityList(item.capabilities).some((name) => ["reranker", "embedding", "embeddings"].includes(name))) {
    return false
  }
  const input = strings(field(item.architecture, "input_modalities"))
  const output = strings(field(item.architecture, "output_modalities"))
  return (!input.length || input.includes("text")) && (!output.length || output.includes("text"))
}

export async function listModels(url: string, headers?: Record<string, string>) {
  const res = await fetch(url + "/v1/models", {
    headers,
    signal: AbortSignal.timeout(1000),
  })
  if (!res.ok) throw new Error(`OpenAI-compatible probe failed: ${res.status}`)
  return ModelsResponseSchema.parse(await res.json()).data
}

async function detect(url: string, headers?: Record<string, string>) {
  try {
    await listModels(url, headers)
    return true
  } catch {
    return false
  }
}

async function probe(url: string, headers?: Record<string, string>): Promise<LocalModel[]> {
  return (await listModels(url, headers)).filter(isChatModel).map(modelFromListing)
}

const openai: ProviderImpl = {
  detect,
  probe,
}

export default openai
