import type { Host } from './types'
import { WebHost } from './web'

declare global {
  interface Window {
    gemmaHost?: Host
  }
}

export const host: Host = window.gemmaHost ?? new WebHost()
