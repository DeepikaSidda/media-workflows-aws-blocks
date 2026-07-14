# Media Workflows — Event-Driven Pipeline on AWS Blocks

A small full-stack app that demonstrates the **event-driven workflow pattern** using [AWS Blocks](https://docs.aws.amazon.com/blocks/latest/devguide/what-is-blocks.html). A user uploads a file; it is stored, processed in the background, streamed with live progress, and confirmed by email. A scheduled job emails a nightly per-user summary.

The same TypeScript code runs **locally on in-memory/filesystem mocks** and **deploys unchanged to real AWS services** — no infrastructure code to hand-write.

---

## What it does

1. **Sign in** — users authenticate (session-based).
2. **Upload** — a file is validated (type + size) and stored in object storage. A job record is created and queued.
3. **Process** — a background worker picks up the job, moves it through `QUEUED → PROCESSING → COMPLETED` (or `FAILED`), and records timestamps.
4. **Live progress** — status and a progress bar update in real time over a WebSocket channel.
5. **Email** — the owner gets a completion email when the job finishes.
6. **Nightly report** — a scheduled job emails each user a 24-hour summary (counts by status). It can also be triggered on demand from the UI.

Each user only ever sees and is notified about their own jobs.

---

## Architecture

| Concern | Block | Local dev | Deployed (AWS) |
|---|---|---|---|
| Auth / sessions | `AuthBasic` | in-memory user store | Cognito-style auth |
| File storage | `FileBucket` | filesystem (`.bb-data/`) | Amazon S3 |
| Job records | `DistributedTable` | JSON on disk | Amazon DynamoDB |
| Background jobs | `AsyncJob` | in-process queue | Amazon SQS + AWS Lambda |
| Live updates | `Realtime` | local WebSocket | AppSync / API Gateway WS |
| Email | `EmailClient` | captured to a local file | Amazon SES |
| Scheduled task | `CronJob` | on-demand trigger | Amazon EventBridge |
| Typed API | `ApiNamespace` | — | API Gateway + Lambda |
| Frontend hosting | `Hosting` | Vite dev server | S3 + CloudFront |

```
Browser ──► API (ApiNamespace) ──► FileBucket (store)
                                └─► DistributedTable (job record)
                                └─► AsyncJob (enqueue)
AsyncJob ──► process job ──► Realtime (progress) ──► EmailClient (completion)
CronJob  ──► nightly report ──► EmailClient (summary)
```

The frontend is a Vite + lit-html app that imports the typed backend API directly from `aws-blocks` — no client code generation.

---

## Project layout

```
media-app/
├─ src/                  # frontend (Vite + lit-html)
│  └─ index.ts
├─ aws-blocks/           # backend
│  ├─ index.ts           # the Blocks app (auth, storage, jobs, realtime, email, cron, API)
│  ├─ index.handler.ts   # Lambda entry point
│  ├─ index.cdk.ts       # CDK app (infra + hosting)
│  └─ scripts/           # dev / deploy / destroy scripts
├─ .blocks/config.json   # stackId + telemetry (committed)
├─ index.html
└─ package.json
```

---

## Prerequisites

- **Node.js 22+**
- For deployment:
  - An **AWS account** with credentials configured (`aws configure`, SSO, or env vars)
  - **CDK bootstrapped** in your target account/region (`cdk bootstrap`)
  - For real email: a **verified identity in Amazon SES** (see [Email](#email) below)

---

## Local development

```bash
npm install
npm run dev
```

This starts the backend on local mocks and the Vite frontend. Open the URL printed in the terminal.

- Uploaded files and job records are written under `.bb-data/`.
- Emails are **not** sent over the network locally — they are captured to
  `.bb-data/media-workflows-notifications/emails.json` so you can inspect them.

---

## Deploying to AWS

```bash
# Throwaway test stack (backend only, easy teardown)
npm run sandbox
npm run sandbox:destroy

# Full production deploy (backend + hosted frontend)
npm run deploy
npm run destroy
```

`npm run deploy` provisions all the AWS resources in the table above and hosts the frontend on CloudFront. The command prints the live **Frontend URL** and **API URL** when it finishes.

> ⚠️ Deploying creates real, billable AWS resources. Run `npm run destroy` when you're done.

### Available scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run locally on mocks |
| `npm run build` | Type-check and build the frontend |
| `npm run typecheck` | Type-check only |
| `npm run sandbox` | Deploy a temporary AWS stack |
| `npm run sandbox:destroy` | Tear down the sandbox stack |
| `npm run deploy` | Full production deploy |
| `npm run destroy` | Tear down the production stack |

---

## Email

The `EmailClient` sends completion emails and nightly summaries.

- **Recipient:** if a user's username is an email address it is used directly; otherwise mail is routed to the address in the `NOTIFY_EMAIL` environment variable.
- **Sender:** configured via the `MAIL_FROM` environment variable.

### Making real email work on AWS (SES)

1. **Verify an identity** in the SES console for the address you send from/to.
   New SES accounts start in **sandbox mode**, which can only send to/from verified addresses.
2. Set `MAIL_FROM` (and `NOTIFY_EMAIL` if needed) to that verified address.
3. To email arbitrary recipients, request **SES production access**.
4. SES verification is **per region** — verify in the same region you deploy to.

---

## Configuration

| Setting | Where | Default |
|---|---|---|
| Accepted upload types | `aws-blocks/index.ts` | JPEG, PNG, GIF, WebP |
| Max upload size | `aws-blocks/index.ts` | 100 MB |
| Sender address | `MAIL_FROM` env | build-time default |
| Notification recipient | `NOTIFY_EMAIL` env | build-time default |
| Nightly report schedule | `aws-blocks/index.ts` (`CronJob`) | 00:00 UTC daily |
| Stack name base | `.blocks/config.json` (`stackId`) | `media-workflows` |

---

## Notes & limitations

- **No image transformation.** This app stores and tracks uploads through an event-driven pipeline; it does not generate thumbnails or extract image metadata. (Native image libraries such as `sharp` do not bundle into the Blocks Lambda, so image processing was intentionally left out.) The `AsyncJob` still demonstrates the full background-processing lifecycle.
- **Open sign-up.** `AuthBasic` allows public registration. Fine for a demo; add restrictions before using with real users.
- **Local vs deployed email.** Local dev only *captures* emails to a file; real delivery happens after deploying with SES configured.

---

## License

Demo / educational project.
