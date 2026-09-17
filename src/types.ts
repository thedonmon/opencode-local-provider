// Detection runs in this order. "openai" matches any server with a /v1/models
// listing, so it must stay last.
export const KINDS = ["ollama", "lmstudio", "llamacpp", "vllm", "exo", "llamaswap", "omlx", "mlxvlm", "openai"] as const

export type LocalProviderKind = (typeof KINDS)[number]

export type LocalModel = {
  id: string
  name?: string
  context: number
  toolcall: boolean
  vision: boolean
  // Read from the running server rather than a listing, so it can be
  // remembered for when the model is unloaded.
  live?: boolean
}

export type LocalTarget = {
  url: string
  kind?: LocalProviderKind
  apiKey?: string
  // llama-swap: also list models that are not loaded yet
  includeUnloaded?: boolean
}
