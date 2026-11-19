import type { EgressBackend } from '@gugu/core/shared/egress'
import { installSystemCertificates, nodeEgressBackend } from './node'
import type { RoutesFor } from './proxy-route'

/** The B desktop shares the Node backend; only its per-URL proxy resolver comes from Chromium. */
export function desktopEgressBackend(routes: RoutesFor, log: EgressBackend['log']): EgressBackend {
  installSystemCertificates()
  return nodeEgressBackend({ name: 'node-system', routes, log, keepAliveTimeoutMs: 60_000 })
}
