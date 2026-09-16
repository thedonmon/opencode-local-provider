import type { LocalModel, LocalProviderKind, LocalTarget } from "../types"

export type ProviderImpl = {
  detect(url: string, headers?: Record<string, string>): Promise<boolean>
  probe(url: string, headers?: Record<string, string>, target?: LocalTarget): Promise<LocalModel[]>
}

export type ProviderMap = Record<LocalProviderKind, ProviderImpl>
