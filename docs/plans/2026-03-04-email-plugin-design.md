# Email Plugin — Design

**Date:** 2026-03-04
**Status:** Draft
**Scope:** `src/plugins/email/` — a `workflow.use()` plugin that adds durable email sending with open and click tracking via pgpass.ai

---

## Goal

Add three step methods to any workflow via `workflow.use(emailPlugin)`:

- `step.sendEmail` — sends an email (user-provided renderer + ESP), instruments HTML for open/click tracking
- `step.waitForOpen` — pauses until the tracking pixel fires (or times out)
- `step.waitForClick` — pauses until the CTA redirect fires (or times out)

The plugin has no engine lifecycle hooks and requires no global registration. It is a pure `WorkflowPlugin` used with `workflow.use()`.

---

## Dependencies

### Enhanced `waitUntil` (separate work)

`waitForOpen` and `waitForClick` depend on an enhanced version of `step.waitUntil` that accepts a condition function polled on a pg-boss schedule:

```typescript
step.waitUntil(stepId, conditionFn: () => Promise<T | false>, duration: Duration)
// → { timedOut: false, data: T } | { timedOut: true }
```

The condition is called on each scheduled tick. Returning `false` continues polling; returning a truthy value resolves the step with that value. This work is assigned to a separate agent and is not in scope here.

### `step.runId` on `StepBaseContext`

The plugin needs `runId` at step execution time to generate tracking tokens. The fix is additive: expose `runId: string` (and `resourceId?: string`) directly on `StepBaseContext`. The engine already has `run.id` when building `baseStep` — this is a one-line addition.

```typescript
// src/types.ts
export type StepBaseContext = {
  runId: string        // NEW
  resourceId?: string  // NEW
  run: ...
  waitFor: ...
  // existing methods unchanged
}
```

---

## Plugin configuration

```typescript
import { createEmailPlugin } from 'pg-workflows/plugins/email'

const emailPlugin = createEmailPlugin({
  trackerUrl: 'https://pgpass.ai',
  secret:     'hmac-secret',      // shared with the tracker for HMAC signing
  apiKey:     'sk_...',           // for polling GET /api/events/<token>
  send: async ({ to, subject, html, text }) => {
    await sgMail.send({ to, subject, html, text })
  },
})
```

The `send` callback is the only required integration point. The user brings their own ESP (SendGrid, SES, Postmark, SMTP, etc.).

---

## Step API

### `step.sendEmail`

```typescript
await step.sendEmail('send-welcome', {
  to:          'user@example.com',  // string or string[]
  subject:     'Welcome!',
  html:        renderedHtml,         // pre-rendered by the user (React Email, MJML, etc.)
  text?:       plainText,            // optional plain-text fallback
  openStepId:  'wait-open',          // step ID whose token goes in the tracking pixel
  clickStepId: 'wait-click',         // step ID whose token goes in the CTA redirect link
})
```

`openStepId` and `clickStepId` declare which downstream wait steps will track this email. The plugin uses these IDs to generate the tracking URLs embedded in the HTML.

### `step.waitForOpen`

```typescript
const result = await step.waitForOpen('wait-open', '3 days')
// or:          step.waitForOpen('wait-open', { days: 3 })
```

**Return type:**

```typescript
type WaitForOpenResult =
  | { done: true;  data: EmailOpenedData }
  | { done: false; state: 'timeout'; duration: Duration }

type EmailOpenedData = {
  openedAt:    string            // ISO timestamp
  userAgent?:  string
  ipAddress?:  string
  language?:   string            // e.g. "en-US"
  os?:         string            // e.g. "iOS 17"
  deviceType?: 'mobile' | 'desktop' | 'tablet'
  location?:   { country?: string; city?: string; region?: string }
  referrer?:   string
}
```

### `step.waitForClick`

```typescript
const result = await step.waitForClick('wait-click', { days: 1 })
```

**Return type:**

```typescript
type WaitForClickResult =
  | { done: true;  data: EmailClickedData }
  | { done: false; state: 'timeout'; duration: Duration }

type EmailClickedData = {
  clickedAt:   string
  url:         string            // the CTA href that was clicked
  userAgent?:  string
  ipAddress?:  string
  language?:   string
  os?:         string
  deviceType?: 'mobile' | 'desktop' | 'tablet'
  location?:   { country?: string; city?: string; region?: string }
  referrer?:   string
}
```

---

## Usage example

```typescript
import { workflow }         from 'pg-workflows'
import { createEmailPlugin } from 'pg-workflows/plugins/email'
import { render }            from '@react-email/render'
import { WelcomeEmail }      from './emails/welcome'

const emailPlugin = createEmailPlugin({
  trackerUrl: 'https://pgpass.ai',
  secret:     process.env.TRACKER_SECRET,
  apiKey:     process.env.TRACKER_API_KEY,
  send: async ({ to, subject, html, text }) => {
    await resend.emails.send({ from: 'hi@acme.com', to, subject, html, text })
  },
})

const onboarding = workflow
  .use(emailPlugin)
  ('onboarding', async ({ step, input }) => {

    const html = await render(<WelcomeEmail name={input.name} />)

    await step.sendEmail('send-welcome', {
      to:          input.email,
      subject:     'Welcome to Acme!',
      html,
      openStepId:  'wait-open',
      clickStepId: 'wait-click',
    })

    const opened = await step.waitForOpen('wait-open', '3 days')

    if (!opened.done) {
      return { outcome: 'no-open', ...opened }
    }

    const clicked = await step.waitForClick('wait-click', { days: 1 })

    return clicked.done
      ? { outcome: 'clicked', url: clicked.data.url }
      : { outcome: 'opened-no-click' }
  })
```

---

## Tracking token format

```
token = base64url(runId:stepId) + "." + truncatedHmac(runId:stepId, secret)
```

- Payload: `runId + ":" + stepId`, base64url-encoded
- HMAC: SHA-256 over the payload using the shared secret, hex-encoded, truncated to 12 chars
- Example: `dXNlcl8xMjM6d2FpdC1vcGVu.a8xK3mPq1234`

The tracker verifies the HMAC before recording any event. The token uniquely identifies a `(runId, stepId)` pair.

---

## `sendEmail` internals

`sendEmail` wraps `step.run` — the send is durable and cached in the timeline. On retry, the email is not re-sent.

Inside `step.run`, the plugin:

1. **Instruments the pixel** — appends before `</body>`:
   ```html
   <img src="https://pgpass.ai/t/<token(runId, openStepId)>"
        width="1" height="1" style="display:none" alt="" />
   ```

2. **Instruments the CTA** — rewrites the first (only) `<a href>` to a redirect URL:
   ```
   https://pgpass.ai/r/<token(runId, clickStepId)>?url=<encodedOriginalHref>
   ```

3. **Calls `send`** with the instrumented `html` and the original `text` (plain text is not instrumented).

4. Returns `{ messageId? }` or similar from the user's `send` callback (persisted in timeline).

---

## `waitForOpen` / `waitForClick` internals

Both delegate to the enhanced `step.waitUntil`:

```typescript
// waitForOpen('wait-open', '3 days') internally:
const result = await step.waitUntil('wait-open', async () => {
  const token = createToken(step.runId, 'wait-open', config.secret)
  const res   = await fetch(`${config.trackerUrl}/api/events/${token}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })
  const body  = await res.json() as TrackerResponse
  return body.found ? body.data : false
}, '3 days')

return result.timedOut
  ? { done: false, state: 'timeout', duration: '3 days' }
  : { done: true,  data: mapToOpenedData(result.data) }
```

`mapToOpenedData` / `mapToClickedData` normalise the raw tracker response fields into the typed return shapes.

---

## Tracker API contract

The plugin expects pgpass.ai to expose:

| Route | Auth | Response |
|---|---|---|
| `GET /t/<token>` | HMAC in token | 1×1 transparent GIF, `Cache-Control: no-store` |
| `GET /r/<token>?url=<target>` | HMAC in token | 302 redirect to target |
| `GET /api/events/<token>` | `Authorization: Bearer <apiKey>` | `{ found: true, data: EventRecord }` or `{ found: false }` |

```typescript
type EventRecord = {
  event:       'open' | 'click'
  url?:        string       // click only
  userAgent?:  string
  ip?:         string
  language?:   string
  os?:         string
  deviceType?: string
  location?:   { country?: string; city?: string; region?: string }
  referrer?:   string
  firedAt:     string       // ISO timestamp
}
```

---

## Files

### New

| File | Purpose |
|---|---|
| `src/plugins/email/index.ts` | Public exports |
| `src/plugins/email/types.ts` | `EmailOpenedData`, `EmailClickedData`, `WaitForOpenResult`, `WaitForClickResult`, `EmailPluginConfig`, `TrackerResponse` |
| `src/plugins/email/token.ts` | `createToken(runId, stepId, secret): string` |
| `src/plugins/email/instrument.ts` | `instrumentHtml(html, { openToken, clickToken, trackerUrl }): string` |
| `src/plugins/email/plugin.ts` | `createEmailPlugin(config)` — the `WorkflowPlugin` factory |

### Modified

| File | Change |
|---|---|
| `src/types.ts` | Add `runId: string` and `resourceId?: string` to `StepBaseContext` |
| `src/engine.ts` | Populate `runId` and `resourceId` on `baseStep` |
| `package.json` / `bunup.config.ts` | Add `pg-workflows/plugins/email` subpath export |
