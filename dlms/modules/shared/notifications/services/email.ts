/**
 * Email delivery, behind a two-implementation interface (spec §9 wants SES eventually;
 * Resend is what the legacy DLMS edge functions already use).
 *
 * THE WHOLE POINT OF THIS MODULE IS THE UNCONFIGURED CASE. The platform is deployed today
 * with no RESEND_API_KEY, and two failure modes had to be designed out:
 *
 *   IT MUST NOT CRASH. A notification is written and visible in the bell before any email
 *   is attempted; a missing mailer must never take down the drain, the reminder sweep, or
 *   a user's server action. So `send` NEVER throws — every implementation returns a
 *   SendResult, and a refusal is a value.
 *
 *   IT MUST NOT SILENTLY SWALLOW. The opposite failure is a system that reports success
 *   for mail it never sent. `notification.emailed_at` is stamped only from
 *   `delivered: true`, so LoggingEmailSender returns `delivered: false` — truthfully — and
 *   emailed_at stays NULL. An unconfigured platform therefore has an empty mail history
 *   rather than a fictional one, and the log line says what WOULD have been sent so the
 *   path is still observable in development.
 *
 * NO NEW DEPENDENCY. Resend's REST API is one POST; the `resend` npm package is not in
 * dlms/package.json (the legacy usage is Deno, inside supabase/functions/), and adding a
 * dependency to send one JSON body would be the more fragile choice.
 */

export type EmailMessage = {
  to: string
  subject: string
  text: string
}

/**
 * `delivered` is the ONLY thing emailed_at may be derived from. `reason` is for the
 * operator's log, never for a user.
 */
export type SendResult = { delivered: boolean; reason?: string }

export interface EmailSender {
  send(message: EmailMessage): Promise<SendResult>
}

/**
 * The no-op used whenever email is not configured.
 *
 * Logs at `info` rather than `warn`: on this deployment an unset key is the EXPECTED
 * state, not a fault, and a warning per notification would train operators to ignore the
 * channel that will eventually carry a real one.
 */
export class LoggingEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<SendResult> {
    console.info(JSON.stringify({
      level: 'info',
      msg: 'email not configured — would have sent',
      to: message.to,
      subject: message.subject,
    }))
    // FALSE, deliberately. See this module's header: a no-op that reported success would
    // stamp emailed_at on mail that never left.
    return { delivered: false, reason: 'email is not configured' }
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/**
 * The real sender.
 *
 * Every failure — a refusal from the API, a network error, a timeout — is caught and
 * returned as `delivered: false`. A bounced email must not fail the notification that has
 * already been written and is already visible in the bell: the in-app copy is the delivery
 * of record, and email is the courtesy on top of it.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    /**
     * Resend requires a verified sender. Left configurable because the verified domain is
     * a deployment fact, and defaulted so a misconfiguration surfaces as an API refusal
     * (recorded, visible) rather than as a TypeError inside the drain.
     */
    private readonly from = process.env.NOTIFICATION_EMAIL_FROM
      ?? 'QTX Operations <onboarding@resend.dev>',
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const reason = `Resend refused the message (${response.status}) ${detail}`.trim()
        console.error(JSON.stringify({ level: 'error', msg: 'email send failed', reason }))
        return { delivered: false, reason }
      }
      return { delivered: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(JSON.stringify({ level: 'error', msg: 'email send failed', reason }))
      return { delivered: false, reason }
    }
  }
}

/**
 * Chooses an implementation from the environment, per call rather than at module load.
 *
 * Not memoised on purpose: a module-level singleton would capture whatever the environment
 * looked like when the module was first imported, which in a serverless runtime is a
 * different moment per instance and is exactly the kind of state that makes "it works
 * locally" untrue in production. Constructing one is free.
 *
 * An EMPTY key is treated as unset — `RESEND_API_KEY=""` in a deployment is a variable
 * somebody meant to fill in, and sending `Authorization: Bearer ` to Resend would turn a
 * clear "not configured" into a 401 per notification.
 */
export function getEmailSender(): EmailSender {
  const key = process.env.RESEND_API_KEY
  if (!key) return new LoggingEmailSender()
  return new ResendEmailSender(key)
}
