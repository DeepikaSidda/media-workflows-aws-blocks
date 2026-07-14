/**
 * Backend — aws-blocks/index.ts  (real AWS Blocks)
 *
 * Media upload & processing workflow built on real Building Blocks:
 *   AuthBasic        — sign in / sessions
 *   FileBucket       — store the uploaded file (S3)
 *   DistributedTable — the Job_Record (status, timestamps) (DynamoDB)
 *   AsyncJob         — background processing (SQS + Lambda): job lifecycle
 *   Realtime         — live status/progress pushed to the owner's channel (AppSync)
 *   EmailClient      — completion email (SES)
 *   CronJob          — nightly per-user usage summary (EventBridge)
 *
 * Runs fully locally via `npm run dev` (in-memory/filesystem mocks) and deploys
 * to AWS unchanged.
 */
import {
  ApiNamespace,
  Scope,
  AuthBasic,
  DistributedTable,
  FileBucket,
  Realtime,
  AsyncJob,
  EmailClient,
  CronJob,
} from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('media-workflows');

// ─── Auth ──────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 6 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});
export const authApi = auth.createApi();

// ─── Config ──────────────────────────────────────────────────────────────────
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB (Req 2.1/2.3)

// ─── Data: the Job_Record ─────────────────────────────────────────────────────
const jobSchema = z.object({
  userId: z.string(),                 // partition key — per-user isolation
  jobId: z.string(),                  // sort key
  status: z.enum(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED']),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  originalKey: z.string(),
  error: z.string().optional(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});
type Job = z.infer<typeof jobSchema>;

const jobs = new DistributedTable(scope, 'jobs', {
  schema: jobSchema,
  key: { partitionKey: 'userId', sortKey: 'jobId' },
});

// ─── Files ─────────────────────────────────────────────────────────────────
const files = new FileBucket(scope, 'media');

// ─── Realtime: live status/progress on a per-user channel ─────────────────────
const rt = new Realtime(scope, 'live', {
  namespaces: {
    jobs: Realtime.namespace(
      z.object({
        jobId: z.string(),
        status: z.string(),
        percent: z.number(),
      }),
    ),
  },
});

// ─── Email ───────────────────────────────────────────────────────────────────
// Sender must be an address/domain you have verified in Amazon SES. Configure it
// via MAIL_FROM so it isn't hardcoded to an address you don't control.
const email = new EmailClient(scope, 'notifications', {
  fromAddress: process.env.MAIL_FROM ?? 'siddadeepika@gmail.com',
});

// Recipient resolution (Req 5.1/5.2/6.3). AuthBasic only carries a username, so
// when that username isn't itself an email we route to a configured, real
// notification address instead of a non-deliverable "<username>@example.com".
const FALLBACK_NOTIFY_EMAIL = process.env.NOTIFY_EMAIL ?? 'siddadeepika@gmail.com';
function recipientFor(userId: string): string {
  return userId.includes('@') ? userId : FALLBACK_NOTIFY_EMAIL;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function publish(userId: string, jobId: string, status: string, percent: number) {
  try {
    await rt.publish('jobs', userId, { jobId, status, percent });
  } catch {
    /* no connected client — silently dropped (Req 4.5) */
  }
}

// ─── AsyncJob: the background processor ───────────────────────────────────────
const processJob = new AsyncJob(scope, 'process', {
  handler: async (payload: { userId: string; jobId: string }) => {
    const { userId, jobId } = payload;
    const record = await jobs.get({ userId, jobId });
    if (!record || record.status === 'COMPLETED' || record.status === 'FAILED') {
      return; // idempotent: unknown or already-terminal jobs are discarded (Req 3.7)
    }

    await jobs.put({ ...record, status: 'PROCESSING' });
    await publish(userId, jobId, 'PROCESSING', 10);

    try {
      const original = await files.get(record.originalKey);
      if (!original) throw new Error('stored upload not found');
      const buf = Buffer.isBuffer(original.body)
        ? original.body
        : Buffer.from(original.body as Uint8Array);

      await publish(userId, jobId, 'PROCESSING', 60);
      await publish(userId, jobId, 'PROCESSING', 90);

      const completed: Job = {
        ...record,
        status: 'COMPLETED',
        completedAt: Date.now(),
      };
      await jobs.put(completed);
      await publish(userId, jobId, 'COMPLETED', 100);

      // Completion email (Req 5.1).
      await email.send({
        to: recipientFor(userId),
        subject: `Your image ${record.filename} is ready`,
        body:
          `Job ${jobId} completed.\n` +
          `Your file "${record.filename}" (${record.sizeBytes} bytes) was stored successfully.`,
      });
    } catch (err) {
      await jobs.put({
        ...record,
        status: 'FAILED',
        error: err instanceof Error ? err.message : 'processing failed',
        completedAt: Date.now(),
      });
      await publish(userId, jobId, 'FAILED', 100);
      throw err; // let AsyncJob apply its retry/DLQ policy (Req 3.4/3.5)
    }
  },
});

// ─── CronJob: nightly per-user usage summary ─────────────────────────────────
async function runReport(): Promise<number> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const byUser = new Map<string, Record<Job['status'], number>>();
  for await (const job of jobs.scan()) {
    if ((job.completedAt ?? job.createdAt) < since) continue;
    const counts = byUser.get(job.userId) ?? { QUEUED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
    counts[job.status] += 1;
    byUser.set(job.userId, counts);
  }
  for (const [userId, counts] of byUser) {
    await email.send({
      to: recipientFor(userId),
      subject: 'Your daily processing summary',
      body: `Last 24h — COMPLETED: ${counts.COMPLETED}, FAILED: ${counts.FAILED}, in-flight: ${counts.QUEUED + counts.PROCESSING}`,
    });
  }
  return byUser.size;
}

new CronJob(scope, 'nightly-report', {
  schedule: 'cron(0 0 * * ? *)', // daily at 00:00 UTC (Req 6.1)
  handler: async () => {
    await runReport();
  },
});

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({
  /** Subscribe to live status/progress for the signed-in user (Req 4.1). */
  async subscribeJobs() {
    const user = await auth.requireAuth(context);
    return rt.getChannel('jobs', user.username);
  },

  /**
   * Upload an image (base64), validate it, store it, create a QUEUED Job_Record,
   * and enqueue background processing (Req 2.1–2.5).
   */
  async uploadImage(filename: string, contentType: string, dataBase64: string) {
    const user = await auth.requireAuth(context);

    if (!ACCEPTED_TYPES.includes(contentType)) {
      return { ok: false as const, error: 'UNSUPPORTED_TYPE', contentType };
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
      return { ok: false as const, error: 'INVALID_SIZE', sizeBytes: bytes.length };
    }

    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const originalKey = `${user.username}/${jobId}/original`;

    await files.put(originalKey, bytes, { contentType });
    await jobs.put({
      userId: user.username,
      jobId,
      status: 'QUEUED',
      filename,
      contentType,
      sizeBytes: bytes.length,
      originalKey,
      createdAt: Date.now(),
    });
    await publish(user.username, jobId, 'QUEUED', 0);
    await processJob.submit({ userId: user.username, jobId });

    return { ok: true as const, jobId };
  },

  /** List the signed-in user's jobs, newest first. */
  async listJobs() {
    const user = await auth.requireAuth(context);
    const all = await Array.fromAsync(
      jobs.query({ where: { userId: { equals: user.username } } }),
    );
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },

  /** Presigned URL for the stored original so the browser can show it. */
  async getImageUrls(jobId: string) {
    const user = await auth.requireAuth(context);
    const job = await jobs.get({ userId: user.username, jobId });
    if (!job) throw new Error('job not found');
    const originalUrl = await files.getUrl(job.originalKey);
    return { originalUrl };
  },

  /** Run the nightly report on demand (Req 6.7) and return how many users got one. */
  async runReportNow() {
    await auth.requireAuth(context);
    const users = await runReport();
    return { users };
  },
}));
