import { z } from "zod"
import type { LocalModel, LocalTarget } from "../types"
import type { ProviderImpl } from "./shared"
import { runtimeContext } from "./llamacpp"
import { listModels, modelFromListing } from "./openai"

const RunningResponseSchema = z.object({
  running: z
    .array(
      z.object({
        model: z.string(),
        state: z.string().optional(),
      }),
    )
    .optional(),
})

export async function runningModels(url: string, headers?: Record<string, string>) {
  try {
    const res = await fetch(url + "/running", {
      headers,
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return new Set<string>()
    const body = RunningResponseSchema.parse(await res.json())
    return new Set(
      (body.running ?? [])
        .filter((item) => !item.state || item.state === "ready")
        .map((item) => item.model),
    )
  } catch {
    return new Set<string>()
  }
}

async function detect(url: string, headers?: Record<string, string>) {
  try {
    // llama-swap exposes /v1/models for all configured models regardless of load state.
    // We check owned_by to distinguish it from other OpenAI-compatible proxies.
    const data = await listModels(url, headers)
    return data.some((item) => item.owned_by === "llama-swap")
  } catch {
    return false
  }
}

async function probe(url: string, headers?: Record<string, string>, target?: LocalTarget): Promise<LocalModel[]> {
  const listed = await listModels(url, headers)
  const loadedModels = await runningModels(url, headers)
  const models = target?.includeUnloaded ? listed : listed.filter((item) => loadedModels.has(item.id))

  return Promise.all(
    models.map(async (item) => {
      const model = modelFromListing(item)
      // Querying /upstream makes llama-swap load the model, so only running
      // models get their live context size. The rest keep the listing metadata.
      if (!loadedModels.has(item.id)) return model
      const context = await runtimeContext(`${url}/upstream/${item.id}`, headers)
      return context ? { ...model, context } : model
    }),
  )
}

const llamaswap: ProviderImpl = {
  detect,
  probe,
}

export default llamaswap
