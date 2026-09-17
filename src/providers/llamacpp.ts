import { z } from "zod"
import type { LocalModel } from "../types"
import type { ProviderImpl } from "./shared"

const PropsSchema = z.object({
  default_generation_settings: z
    .object({ n_ctx: z.number().optional() })
    .optional(),
  modalities: z.object({ vision: z.boolean().optional() }).nullish(),
  chat_template_caps: z.object({ supports_tools: z.boolean().optional() }).nullish(),
})

const SlotsSchema = z.array(z.object({ n_ctx: z.number().optional() }))

const ModelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        meta: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .optional(),
})

export type RuntimeInfo = {
  context?: number
  vision?: boolean
  toolcall?: boolean
}

// What a running llama-server reports about the model it has loaded.
export async function runtimeInfo(url: string, headers?: Record<string, string>): Promise<RuntimeInfo> {
  const info: RuntimeInfo = {}
  try {
    const propsRes = await fetch(url + "/props", {
      headers,
      signal: AbortSignal.timeout(1000),
    })
    if (propsRes.ok) {
      const parsed = PropsSchema.parse(await propsRes.json())
      info.vision = parsed.modalities?.vision
      info.toolcall = parsed.chat_template_caps?.supports_tools
      if (parsed.default_generation_settings?.n_ctx) {
        info.context = parsed.default_generation_settings.n_ctx
        return info
      }
    }
  } catch {}

  const context = await slotsContext(url, headers)
  return context ? { ...info, context } : info
}

export async function runtimeContext(url: string, headers?: Record<string, string>) {
  return (await runtimeInfo(url, headers)).context ?? null
}

async function slotsContext(url: string, headers?: Record<string, string>) {
  try {
    const slotsRes = await fetch(url + "/slots", {
      headers,
      signal: AbortSignal.timeout(1000),
    })
    if (slotsRes.ok) {
      const parsed = SlotsSchema.parse(await slotsRes.json())
      const loaded = parsed.find(
        (slot) => slot.n_ctx && slot.n_ctx > 0,
      )?.n_ctx
      if (loaded) return loaded
    }
  } catch {}

  return null
}

async function detect(url: string, headers?: Record<string, string>) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return false
    return res.headers.get("Server")?.toLowerCase() === "llama.cpp"
  } catch {
    return false
  }
}

async function probe(url: string, headers?: Record<string, string>): Promise<LocalModel[]> {
  const loadedContext = await runtimeContext(url, headers)
  const res = await fetch(url + "/v1/models", {
    headers,
    signal: AbortSignal.timeout(1000),
  })
  if (!res.ok) throw new Error(`llama.cpp probe failed: ${res.status}`)
  const body = ModelsResponseSchema.parse(await res.json())

  return (body.data ?? []).map((item) => ({
    id: item.id,
    context: Number(
      loadedContext ??
        item.meta?.n_ctx ??
        item.meta?.n_ctx_train ??
        0,
    ),
    toolcall: false,
    vision: false,
  }))
}

const llamacpp: ProviderImpl = {
  detect,
  probe,
}

export default llamacpp
