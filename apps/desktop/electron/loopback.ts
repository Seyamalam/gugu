import WebSocket, { type ClientOptions } from 'ws'
import http, { type RequestOptions, type IncomingMessage, type ClientRequest } from 'node:http'
import https from 'node:https'
import { isAbsolute } from 'node:path'
import { isLoopbackHost } from '../../../packages/core/src/shared/loopback.ts'

const localAgent = new http.Agent({ keepAlive: true })
const localSecureAgent = new https.Agent({ keepAlive: true })

/** This boundary cannot be used to open an external connection. No DNS lookups are involved in admission. */
function assertLocal(address: string | URL): void {
  const value = String(address)
  if (value.startsWith('ws+unix:///')) return
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
    || !isLoopbackHost(host)) {
    throw new Error('Local transport requires a loopback address or an absolute Unix socket')
  }
}

export function loopbackWebSocket(address: string | URL, options?: ClientOptions): WebSocket {
  assertLocal(address)
  return new WebSocket(address, { ...options, agent: String(address).startsWith('wss:') ? localSecureAgent : localAgent })
}

/** Standalone adapters keep the WHATWG event API on the same explicitly direct local transport. */
export function whatwgLoopbackWebSocket(address: string | URL): globalThis.WebSocket {
  return loopbackWebSocket(address) as unknown as globalThis.WebSocket
}

type HttpAnswer = (response: IncomingMessage) => void
export function loopbackRequest(options: RequestOptions, callback?: HttpAnswer): ClientRequest
export function loopbackRequest(url: string | URL, options?: RequestOptions, callback?: HttpAnswer): ClientRequest
export function loopbackRequest(input: string | URL | RequestOptions, optionsOrCallback?: RequestOptions | HttpAnswer, callback?: HttpAnswer): ClientRequest {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : undefined
  const options = url ? typeof optionsOrCallback === 'object' ? optionsOrCallback : {} : input as RequestOptions
  if (options.socketPath) {
    if (!isAbsolute(options.socketPath)) throw new Error('Local transport requires an absolute socket path')
  } else {
    const host = options.hostname ?? options.host ?? url?.hostname ?? 'localhost'
    const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
    if (!isLoopbackHost(normalized)) {
      throw new Error('Local transport requires a loopback address')
    }
  }
  const answer = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
  // An explicit agent keeps NODE_USE_ENV_PROXY or the global agent from sending local traffic through a proxy.
  const protocol = options.protocol ?? url?.protocol ?? 'http:'
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error('Local HTTP transport requires HTTP or HTTPS')
  const transport = protocol === 'https:' ? https : http
  const agent = protocol === 'https:' ? localSecureAgent : localAgent
  return url ? transport.request(url, { ...options, agent }, answer) : transport.request({ ...options, agent }, answer)
}
