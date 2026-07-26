// Microsoft Graph `POST /me/sendMail` — primary send path for the Outlook
// provider. SMTP AUTH is server-side disabled for new (2024+) personal
// Outlook.com mailboxes with no user toggle (Mozilla SUMO: "For new
// accounts, SMTP always starts disabled."; Microsoft Q&A 5816949: "no
// user toggle available"). Graph is Microsoft's recommended replacement
// for send on consumer accounts.
//
// Graph accepts raw RFC5322 MIME when the request body is base64-encoded
// and Content-Type is `text/plain`:
// https://learn.microsoft.com/graph/api/user-sendmail#example-2-send-a-new-message-using-mime-format
//
// The access token MUST have `aud=graph.microsoft.com` with scope
// `Mail.Send`. An outlook.office.com-audience token (used for IMAP) will
// NOT work here — tokens are resource-bound. Caller gets the correct
// token via `getOutlookGraphSendAccessToken(accountId)`.

import { buildRawMessage, type SendMailOptions } from './smtp'
import { withNetSpan } from './telemetry'
import { bucketBodySize, providerFromHost } from '../../electron/metricsBuckets'

export class GraphSendError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string, message?: string) {
    super(message || `Graph sendMail failed (HTTP ${status})`)
    this.name = 'GraphSendError'
    this.status = status
    this.body = body
  }
}

export type GraphSendParams = {
  accessToken: string
  options: SendMailOptions & { messageId?: string }
  /** Optional `fetch` override for tests. */
  fetchImpl?: typeof fetch
}

/**
 * Send an email via Microsoft Graph on behalf of the authenticated user.
 * Returns `{ messageId }` on success (Graph 202 Accepted response has no
 * body; messageId is taken from the compiled MIME's `Message-ID` header
 * which `MailComposer` generates during compile).
 *
 * Throws `GraphSendError` on non-2xx HTTP response.
 */
export async function sendMailViaGraph(params: GraphSendParams): Promise<{ messageId: string }> {
  const { accessToken, options } = params
  const fetchImpl = params.fetchImpl ?? fetch

  const bodyBytes =
    Buffer.byteLength(options.text || '', 'utf8')
    + Buffer.byteLength(options.html || '', 'utf8')
    + (options.attachments?.reduce((n, a) => n + Math.floor((a.contentBase64?.length || 0) * 0.75), 0) ?? 0)
  const spanAttrs = {
    provider: providerFromHost('graph.microsoft.com'),
    has_attachments: Boolean(options.attachments && options.attachments.length > 0),
    size_bucket: bucketBodySize(bodyBytes),
  }

  return withNetSpan('smtp.send', spanAttrs, async () => {
    const mime = await buildRawMessage(options)
    const bodyBase64 = mime.toString('base64')

    // Note: `saveToSentItems=false` is documented for Graph sendMail's
    // JSON request shape only — the MIME variant (text/plain + base64)
    // auto-saves to the mailbox's default Sent Items folder regardless
    // (Microsoft Q&A 2122804). Caller (`sendMailWithAccountConfig`) skips
    // the IMAP APPEND for Outlook accounts to avoid duplicates.
    const res = await fetchImpl('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'text/plain',
      },
      body: bodyBase64,
    })

    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => '')
      throw new GraphSendError(res.status, text)
    }

    // Extract Message-ID from compiled MIME headers. MailComposer generates
    // `Message-ID: <xxxx@domain>` during `compile()`. Graph does NOT echo
    // this back; we rely on our own generated value.
    const idMatch = /^message-id:\s*<([^>]+)>/im.exec(mime.toString('utf8', 0, Math.min(mime.length, 4096)))
    const messageId = idMatch ? idMatch[1] : ''
    return { messageId }
  })
}
