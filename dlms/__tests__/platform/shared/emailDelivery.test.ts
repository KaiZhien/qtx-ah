import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getEmailSender, LoggingEmailSender, ResendEmailSender,
} from '@/modules/shared/notifications/services/email'

/**
 * Email delivery sits behind an interface with two implementations, and the choice between
 * them is made by whether RESEND_API_KEY is set. The tests that matter are about the
 * UNCONFIGURED case: the platform runs with no key today, and it must neither crash nor
 * pretend.
 */

const OLD_ENV = { ...process.env }
afterEach(() => { process.env = { ...OLD_ENV }; vi.restoreAllMocks() })

describe('getEmailSender', () => {
  it('returns the no-op logging sender when RESEND_API_KEY is UNSET', () => {
    delete process.env.RESEND_API_KEY
    expect(getEmailSender()).toBeInstanceOf(LoggingEmailSender)
  })

  it('returns the no-op logging sender when RESEND_API_KEY is EMPTY', () => {
    process.env.RESEND_API_KEY = ''
    expect(getEmailSender()).toBeInstanceOf(LoggingEmailSender)
  })

  it('returns the Resend sender once a key is configured', () => {
    process.env.RESEND_API_KEY = 're_test_key'
    expect(getEmailSender()).toBeInstanceOf(ResendEmailSender)
  })
})

describe('LoggingEmailSender', () => {
  it('reports delivered:false — an unconfigured platform must not claim it sent mail', () => {
    // This is the property emailed_at depends on. A no-op that returned `true` would
    // stamp a mail history that never happened.
    const sender = new LoggingEmailSender()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    return expect(sender.send({
      to: 'a@example.com', subject: 'Hi', text: 'Body',
    })).resolves.toEqual({ delivered: false, reason: 'email is not configured' })
  })

  it('does not throw — an unconfigured mailer must never break the caller', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    return expect(new LoggingEmailSender().send({
      to: 'a@example.com', subject: 'Hi', text: 'Body',
    })).resolves.toBeDefined()
  })

  it('logs what it WOULD have sent, so the path is observable in development', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    return new LoggingEmailSender()
      .send({ to: 'a@example.com', subject: 'Hi', text: 'Body' })
      .then(() => {
        expect(info).toHaveBeenCalled()
        expect(String(info.mock.calls[0][0])).toContain('a@example.com')
      })
  })
})

describe('ResendEmailSender', () => {
  beforeEach(() => { process.env.NOTIFICATION_EMAIL_FROM = 'QTX <ops@qtx.example>' })

  it('reports delivered:true on a 200 from the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new ResendEmailSender('re_key')
      .send({ to: 'a@example.com', subject: 'Hi', text: 'Body' })

    expect(result.delivered).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('api.resend.com')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_key')
  })

  it('reports delivered:false — WITHOUT throwing — when the API refuses', async () => {
    // A bounced email must not fail the notification that has already been written and
    // is already visible in the bell. The in-app copy is the delivery of record.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('nope', { status: 422 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ResendEmailSender('re_key')
      .send({ to: 'a@example.com', subject: 'Hi', text: 'Body' })
    expect(result.delivered).toBe(false)
    expect(result.reason).toContain('422')
  })

  it('reports delivered:false — WITHOUT throwing — when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ResendEmailSender('re_key')
      .send({ to: 'a@example.com', subject: 'Hi', text: 'Body' })
    expect(result.delivered).toBe(false)
    expect(result.reason).toContain('ECONNREFUSED')
  })
})
