import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import tls from 'node:tls'
import { createEgress, egressHost, EgressError, type EgressBackend, type EnvironmentFetch, type Egress } from '@gugu/core/shared/egress'
import { nodeEgressBackend } from './node'
import { envRoutes } from './proxy-route'

const ENVIRONMENT_INPUTS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'] as const

/** Equivalent harness environments reuse one pool even when callers create fresh context objects. */
export function createEnvironmentFetch(log?: EgressBackend['log']): EnvironmentFetch {
  const transports = new Map<string, Egress>()
  return async (env, input, init) => {
    const inputs = Object.fromEntries(ENVIRONMENT_INPUTS.map(name => [name, env[name]]))
    const key = JSON.stringify(ENVIRONMENT_INPUTS.map(name => inputs[name] ?? ''))
    let transport = transports.get(key)
    if (!transport) {
      const ca = [...tls.getCACertificates('default'), ...tls.getCACertificates('system')]
      try {
        for (const file of [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS]) if (file) ca.push(readFileSync(file, 'utf8'))
        if (env.SSL_CERT_DIR) {
          for (const name of readdirSync(env.SSL_CERT_DIR)) {
            if (/\.(pem|crt)$|^[0-9a-f]+\.\d+$/i.test(name)) ca.push(readFileSync(join(env.SSL_CERT_DIR, name), 'utf8'))
          }
        }
      } catch (cause) {
        const host = egressHost(input)
        log?.({ kind: 'tls', proxies: [], host, backend: 'node-harness-env', cause })
        throw new EgressError('tls', host, cause)
      }
      transport = createEgress(nodeEgressBackend({ name: 'node-harness-env', routes: envRoutes(inputs), ca: [...new Set(ca)], log }))
      transports.set(key, transport)
    }
    return transport.fetch(input, init)
  }
}
