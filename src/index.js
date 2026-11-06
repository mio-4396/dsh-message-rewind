/**
 * Host half of dsh-message-rewind.
 *
 * The feature runs in the browser, but stopping a turn belongs to the Agent and
 * a plain-JS Client half has no Remote namespace, so the browser asks through
 * this route: `POST /.dsh-message-rewind/cancel` stops the turn that is running
 * for one Session, which is what a withdrawal needs before it can hand the text
 * back to the composer.
 *
 * @module dsh-message-rewind
 */

export const name = 'dsh-message-rewind'

/** Route prefix registered on the DSH web server. */
const ROUTE_PREFIX = '/.dsh-message-rewind'

/** Largest request body accepted, in bytes. */
const MAX_BODY = 8 * 1024

/** Write one JSON answer. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  res.end(payload)
}

/** Read a bounded JSON body. */
async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

export function apply(ctx) {
  ctx.effect(() => {
    const stop = ctx.inject(['webServer'], (scope) => {
      const webServer = scope.webServer ?? ctx.get('webServer')
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
        console.error('[dsh-message-rewind] the webServer service has no register(): withdrawal cannot stop a turn')
        return undefined
      }
      const handler = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length)
        try {
          if (route === '/cancel' && req.method === 'POST') {
            const body = await readJson(req)
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
            if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
            const controller = ctx.get('sessionController')
            if (controller === undefined || typeof controller.cancel !== 'function') {
              return sendJson(res, 200, { ok: false, error: 'session-controller-unavailable' })
            }
            const value = controller.cancel({ sessionId })
            const accepted = value !== null && typeof value === 'object' && value.accepted === true
            return sendJson(res, 200, { ok: accepted })
          }
          return sendJson(res, 404, { ok: false, error: 'unknown-route' })
        } catch (error) {
          // A Session that is not attached has no turn to stop; the Client treats
          // that as "nothing was running" and still restores the draft.
          return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      }
      const dispose = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    })
    return () => {
      if (typeof stop === 'function') stop()
    }
  }, 'dsh-message-rewind: turn cancellation route')
}
