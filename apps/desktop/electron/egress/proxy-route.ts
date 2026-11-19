/**
 * Where a request to a URL goes: the one place that turns a proxy answer into routes.
 *
 * Desktop: ask Chromium (`session.resolveProxy`) per origin — system proxy, PAC and its bypass list included. Answers
 * are kept for a few seconds (`cachedProxyAnswers`), so a proxy switched on after start counts within that window. A headless host or server has no
 * Chromium; its only source is the environment (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`).
 * Loopback always goes direct: those are Gugu's own local endpoints and the user's local model servers.
 */

import { isLoopbackHost } from '@gugu/core/shared/loopback'
export { isLoopbackHost } from '@gugu/core/shared/loopback'

export type ProxyServerKind = 'http' | 'https' | 'socks5' | 'socks4'
export type ProxyServer = { kind: ProxyServerKind; host: string; port: number; username?: string; password?: string }
export type ProxyRoute = { kind: 'direct' } | ProxyServer

/** Endpoint display only: no userinfo, URL path, query, or PAC source. Keep explicit ports, including defaults. */
export function proxyEndpoints(routes: readonly ProxyRoute[]): string[] {
  return routes.flatMap(route => {
    if (route.kind === 'direct') return []
    const host = new URL(`${route.kind}://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}`).hostname
    return [`${route.kind}://${host}:${route.port}`]
  })
}

export type RoutesFor = (url: string) => Promise<ProxyRoute[]>
export class ProxyRouteError extends Error {
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = 'ProxyRouteError' }
}

let installedRoutes: RoutesFor | undefined
export function installProxyRoutes(routes: RoutesFor): void { installedRoutes = routes }
export function proxyRoutesFor(url: string): Promise<ProxyRoute[]> {
  if (!installedRoutes) throw new Error('egress: proxy resolver is not installed')
  return installedRoutes(url)
}

const DIRECT: ProxyRoute = { kind: 'direct' }

/**
 * Chromium's answer, in order: `PROXY h:p`, `HTTPS h:p`, `SOCKS5 h:p`, `SOCKS h:p` (v4), `DIRECT`, separated by `;`
 * with or without a space. Invalid entries fail rather than silently changing the user's network route.
 */
export function parseProxyAnswer(answer: string): ProxyRoute[] {
  const routes: ProxyRoute[] = []
  for (const item of answer.split(';')) {
    const [scheme = '', hostPort = ''] = item.trim().split(/\s+/)
    const kind = scheme.toUpperCase()
    if (kind === 'DIRECT') { routes.push(DIRECT); continue }
    const at = hostPort.lastIndexOf(':')
    const host = hostPort.slice(0, at).replace(/^\[|\]$/g, ''), port = Number(hostPort.slice(at + 1))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyRouteError('Invalid proxy endpoint')
    const mapped = ({ PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS: 'socks4', SOCKS4: 'socks4' } as Record<string, ProxyServerKind | undefined>)[kind]
    if (!mapped) throw new ProxyRouteError('Unsupported proxy configuration')
    routes.push({ kind: mapped, host, port })
  }
  if (!routes.length) throw new ProxyRouteError('Proxy resolver returned no routes')
  return routes
}

/**
 * @@@proxy-answer-cache - one `resolveProxy` answer per `scheme://host:port`, kept `ttlMs`.
 * Measured on Electron 45 (lane evidence `resolve-cost-out.jsonl`): a fixed proxy or a rules-only PAC answers in
 * ~0.04–0.1 ms, but a PAC that calls `dnsResolve` took p50 2.6 ms / p90 up to 325 ms for a repeated origin and
 * 200–380 ms for a new one. Electron has no proxy-changed event, and switching a proxy (e.g. Clash's mode) changes no
 * network interface, so the window must stay short; resume from sleep empties it. Failures are never kept.
 */
export function cachedProxyAnswers(resolve: (url: string) => Promise<string>, ttlMs: number, now: () => number = Date.now) {
  const answers = new Map<string, { at: number; answer: Promise<string> }>()
  const MAX = 512
  return {
    resolve(url: string): Promise<string> {
      const target = new URL(url)
      const key = `${target.protocol}//${target.host}`
      const kept = answers.get(key)
      if (kept && now() - kept.at < ttlMs) return kept.answer
      if (answers.size >= MAX) answers.clear()
      const answer = resolve(url)
      answers.set(key, { at: now(), answer })
      answer.catch(() => { if (answers.get(key)?.answer === answer) answers.delete(key) })
      return answer
    },
    clear(): void { answers.clear() },
  }
}

export function chromiumRoutes(resolveProxy: (url: string) => Promise<string>, env: NodeJS.ProcessEnv = process.env, invalidCredentials?: (variable: string) => void): RoutesFor {
  return async (url) => {
    if (isLoopbackHost(new URL(url).hostname)) return [DIRECT]
    try {
      const routes = parseProxyAnswer(await resolveProxy(url))
      if (routes.every(route => route.kind === 'direct')) return routes
      // Chromium discards URL userinfo. Env may supply credentials for the selected proxy, never another route.
      const target = new URL(url)
      let credentials: ProxyServer | null
      try { credentials = environmentProxy(target, env) }
      catch {
        // Env supplies optional credentials here, never routing. A malformed value cannot invalidate OS/PAC routes.
        const source = environmentProxySource(target, env)
        if (source) invalidCredentials?.(source.variable)
        return routes
      }
      if (!credentials || !(credentials.username || credentials.password)) return routes
      return routes.map(route => route.kind !== 'direct' && route.kind === credentials.kind
        && route.host.toLowerCase() === credentials.host.toLowerCase() && route.port === credentials.port
        ? { ...route, username: credentials.username, password: credentials.password } : route)
    }
    catch (error) { throw new ProxyRouteError('System proxy resolution failed', error) }
  }
}

/**
 * Chromium's own requests (renderer pages, sign-in) meet the same proxy: its challenge is answered from the same source,
 * the environment proxy URL chosen for the request's scheme, only when that URL names the challenging proxy's host and port.
 */
export function proxyChallengeCredentials(challenge: { host: string; port: number }, requestUrl: string, env: NodeJS.ProcessEnv = process.env): { username: string; password: string } | null {
  let proxy: ProxyServer | null
  try { proxy = environmentProxy(new URL(requestUrl), env) } catch { return null }
  if (!proxy || !(proxy.username || proxy.password)) return null
  const host = challenge.host.replace(/^\[|\]$/g, '').toLowerCase()
  if (proxy.host.toLowerCase() !== host || proxy.port !== challenge.port) return null
  return { username: proxy.username ?? '', password: proxy.password ?? '' }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string { return env[name.toLowerCase()] ?? env[name] ?? '' }

function environmentProxySource(target: URL, env: NodeJS.ProcessEnv): { variable: string; value: string } | null {
  const secure = target.protocol === 'https:' || target.protocol === 'wss:'
  for (const name of [secure ? 'HTTPS_PROXY' : 'HTTP_PROXY', 'ALL_PROXY']) {
    const variable = env[name.toLowerCase()] !== undefined ? name.toLowerCase() : name
    const value = env[variable]
    if (value) return { variable, value }
  }
  return null
}

/** The URL is also a credential source when Chromium already selected this endpoint; NO_PROXY is routing only. */
function environmentProxy(target: URL, env: NodeJS.ProcessEnv): ProxyServer | null {
  const source = environmentProxySource(target, env)
  if (!source) return null
  const raw = source.value
  let proxy: URL
  try { proxy = new URL(raw.includes('://') ? raw : `http://${raw}`) }
  catch (error) { throw new ProxyRouteError('Invalid environment proxy', error) }
  const kind = ({ 'http:': 'http', 'https:': 'https', 'socks5:': 'socks5', 'socks5h:': 'socks5', 'socks4:': 'socks4', 'socks:': 'socks5' } as Record<string, ProxyServerKind | undefined>)[proxy.protocol]
  if (!kind) throw new ProxyRouteError('Unsupported environment proxy scheme')
  const port = Number(proxy.port) || (kind === 'https' ? 443 : kind === 'http' ? 80 : 1080)
  return { kind, host: proxy.hostname.replace(/^\[|\]$/g, ''), port, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) }
}

/** Environment proxies the way curl reads them; `NO_PROXY` entries are suffixes, `*` means everything. */
export function envRoutes(env: NodeJS.ProcessEnv = process.env): RoutesFor {
  return async (url) => {
    const target = new URL(url)
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (isLoopbackHost(host)) return [DIRECT]
    const targetPort = target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? '443' : '80')
    const noProxy = envValue(env, 'NO_PROXY').split(/[,\s]+/).filter(Boolean)
    if (noProxy.some(entry => {
      if (entry === '*') return true
      const endpoint = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.toLowerCase())
      if (endpoint?.[2] && endpoint[2] !== targetPort) return false
      const name = (endpoint?.[1] ?? entry).replace(/^\[|\]$/g, '').replace(/^\*?\./, '').toLowerCase()
      return host === name || host.endsWith(`.${name}`)
    })) return [DIRECT]
    return [environmentProxy(target, env) ?? DIRECT]
  }
}
