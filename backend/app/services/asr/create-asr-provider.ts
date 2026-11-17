import { config } from '../../core/config.js'
import { BailianAsrProvider, UnconfiguredAsrProvider } from './bailian-asr-provider.js'
import type { AsrProvider } from './asr-provider.js'

export function createAsrProvider(source: {
  asrApiKey: string
  asrModel: string
  asrWsUrl: string
} = config): AsrProvider {
  if (source.asrApiKey.trim().length === 0) return new UnconfiguredAsrProvider()
  return new BailianAsrProvider({
    apiKey: source.asrApiKey,
    model: source.asrModel,
    wsUrl: source.asrWsUrl,
  })
}
