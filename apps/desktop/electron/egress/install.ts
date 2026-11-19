import { app, powerMonitor, session } from 'electron'
import { createEgress, installEgress, type EgressBackend } from '@gugu/core/shared/egress'
import { createLogger } from '../lib/logger'
import { installSystemCertificates, nodeEgressBackend } from './node'
import { cachedProxyAnswers, chromiumRoutes, envRoutes, installProxyRoutes, proxyChallengeCredentials } from './proxy-route'
import { desktopEgressBackend } from './desktop'
import { createEnvironmentFetch } from './environment'

const log: EgressBackend['log'] = ({ kind, host, backend, cause, proxies }) => {
  // Errors can include full request/proxy URLs. Record codes and route kind without leaking credentials or query strings.
  const detail = cause instanceof Error ? cause as Error & { code?: string; route?: string } : null
  const chromiumCode = cause instanceof Error ? /\bnet::ERR_[A-Z0-9_]+/.exec(cause.message)?.[0] : undefined
  createLogger('egress').warn({ kind, host, backend, proxies, route: detail?.route ?? backend, cause: detail?.name, code: detail?.code ?? chromiumCode }, 'egress: no answer')
}

const warnedCredentialVariables = new Set<string>()
/** Bounds how long a proxy switched on or off keeps the old route for an origin; see cachedProxyAnswers. */
const PROXY_ANSWER_TTL_MS = 5_000

/** Install before the first network operation in each host entrypoint. */
export function installHostEgress(): void {
  const desktop = process.type === 'browser'
  // @@@proxy-config-ready - right after ready, Chromium answers resolveProxy with DIRECT before it has read the proxy
  // configuration (Electron 45: one wrong answer within ~40–60 ms of ready). One awaited reload makes the first answer
  // the configured one; it costs ~30–50 ms, paid only by requests made in that window.
  const configured = desktop ? session.defaultSession.forceReloadProxyConfig() : null
  const answers = configured ? cachedProxyAnswers(url => configured.then(() => session.defaultSession.resolveProxy(url)), PROXY_ANSWER_TTL_MS) : null
  if (answers) powerMonitor.on('resume', answers.clear)
  // Renderer pages reach the cloud on Chromium's stack; a proxy's challenge there gets the same credentials, once
  // (a wrong password then fails as a proxy-auth error instead of being offered again).
  if (desktop) app.on('login', (event, _webContents, details, authInfo, callback) => {
    if (!authInfo.isProxy || !details.firstAuthAttempt) return
    const credentials = proxyChallengeCredentials(authInfo, details.url)
    if (!credentials) return
    event.preventDefault()
    callback(credentials.username, credentials.password)
  })
  const routes = answers ? chromiumRoutes(answers.resolve, process.env,
    variable => {
      if (warnedCredentialVariables.has(variable)) return
      warnedCredentialVariables.add(variable)
      createLogger('egress').warn({ variable }, 'egress: ignored invalid proxy credential source')
    }) : envRoutes()
  installProxyRoutes(routes)
  let backend: EgressBackend
  if (desktop) backend = desktopEgressBackend(routes, log)
  else {
    installSystemCertificates()
    backend = nodeEgressBackend({ name: 'node-env', routes, log })
  }
  const installed = createEgress(backend)
  installEgress(installed, createEnvironmentFetch(log))
}
