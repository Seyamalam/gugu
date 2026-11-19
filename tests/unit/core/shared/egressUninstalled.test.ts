// @vitest-environment node
import { expect, it, vi } from 'vitest'

// tests/support/setup.ts installs a test egress; a fresh module copy shows what a host entry gets before it installs one.
it('fails loudly when a host process reaches the network before installing an egress', async () => {
  vi.resetModules()
  const { egress } = await import('@gugu/core/shared/egress')
  const global = vi.spyOn(globalThis, 'fetch')
  expect(() => egress.fetch('https://cloud.example/rest/v1/x')).toThrow(/no backend installed/)
  expect(() => egress.webSocket('wss://cloud.example/realtime')).toThrow(/no backend installed/)
  expect(global).not.toHaveBeenCalled()
  global.mockRestore()
})
