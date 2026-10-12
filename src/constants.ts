export const LOCAL_PROVIDER_ID = "local"
export const LOCAL_PROVIDER_NAME = "Local LLM Provider"
export const LOCAL_PLUGIN_ID = "opencode-local-provider"
export const LOCAL_PLUGIN_SERVICE = "opencode-local-provider"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const LEGACY_TARGET_ID = "default"
export const DEFAULT_CONTEXT = 32768
// OpenCode never asks for more output than this per request.
export const MAX_OUTPUT = 32_000
// OpenCode v2 keeps targets added from /connect as connections of their own
// integration. It must not be the provider's integration, or OpenCode would
// send the newest target's key to every model.
export const LOCAL_TARGETS_INTEGRATION_ID = "local-targets"
export const LOCAL_TARGETS_INTEGRATION_NAME = "Local LLM Servers"
// The integration OpenCode v2 looks up the `local` provider's credential in.
// Nothing is ever saved under it, so each model keeps its own target's key.
// Without it OpenCode uses the `local` integration, where the v1 empty-key
// credential lands when auth.json is migrated, and every request then fails
// with "Missing auth credential: apiKey".
export const LOCAL_PROVIDER_INTEGRATION_ID = "local-provider"
export const V2_OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible"
