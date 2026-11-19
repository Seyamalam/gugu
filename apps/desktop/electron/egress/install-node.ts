import { createEgress, installEgress, type EgressBackend } from '@gugu/core/shared/egress'
import { installSystemCertificates, nodeEgressBackend } from './node'
import { createEnvironmentFetch } from './environment'
import { envRoutes, installProxyRoutes } from './proxy-route'

/** Standalone workers have no Electron module or system-proxy API. */
export function installNodeEgress(): void {
  const log: EgressBackend['log'] = ({ kind, host, backend }) => {
    process.stderr.write(`${JSON.stringify({ event: 'egress: no answer', kind, host, backend })}\n`)
  }
  installSystemCertificates()
  const routes = envRoutes()
  installProxyRoutes(routes)
  installEgress(createEgress(nodeEgressBackend({ name: 'node-env', routes, log })), createEnvironmentFetch(log))
}
