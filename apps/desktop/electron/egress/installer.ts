import { proxyRoutesFor } from './proxy-route'
import { withLoopbackNoProxy } from '@gugu/session-core/agents/agent-env'
import { createLogger } from '../lib/logger'

/** Only Gugu-owned installers use this adaptation; never pass this environment to a harness. */
export async function installerEnvironment(origin: string, source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = withLoopbackNoProxy(source)
  // Explicit shell routes are authoritative; only fill an installer that has none.
  if (Object.entries(source).some(([key, value]) => /^(https?|all)_proxy$/i.test(key) && value)) return env
  const [route] = await proxyRoutesFor(new URL(origin).origin)
  if (!route) throw new Error('Installer proxy resolver returned no routes')
  if (route.kind === 'direct') return env
  if (route.kind !== 'http' && route.kind !== 'https') {
    createLogger('egress/installer').warn({ route: route.kind }, 'Installer cannot express this system proxy; leaving its environment unchanged')
    return env
  }
  const proxy = new URL(`${route.kind}://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}`)
  proxy.username = route.username ?? ''
  proxy.password = route.password ?? ''
  env.HTTP_PROXY = env.http_proxy = env.HTTPS_PROXY = env.https_proxy = proxy.href
  return env
}
