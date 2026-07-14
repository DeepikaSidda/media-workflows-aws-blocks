/**
 * Frontend — src/index.ts
 *
 * Media upload & processing UI. Imports the typed backend API via `aws-blocks`
 * (no client generation). Uploads an image, watches live progress over the
 * Realtime channel, and shows the stored original.
 */
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, AuthenticatedContent, onAuthChange } from '@aws-blocks/blocks/ui';
import { html, render } from 'lit-html';

const menuBarEl = document.getElementById('menu-bar')!;
menuBarEl.appendChild(AccountMenuBar(authApi));

onAuthChange(authApi, (user) => {
  document.getElementById('signInMessage')!.style.display = user == null ? '' : 'none';
});

type Job = {
  jobId: string;
  status: string;
  filename: string;
  sizeBytes: number;
  error?: string;
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

document.getElementById('app')!.appendChild(
  AuthenticatedContent(authApi, () => {
    const container = document.createElement('div');
    let jobs: Job[] = [];
    const progress = new Map<string, number>();
    const urls = new Map<string, { originalUrl: string }>();
    let msg = '';

    async function load() {
      jobs = (await api.listJobs()) as Job[];
      for (const j of jobs) {
        if (j.status === 'COMPLETED' && !urls.has(j.jobId)) {
          try {
            const u = await api.getImageUrls(j.jobId);
            urls.set(j.jobId, { originalUrl: u.originalUrl });
          } catch { /* ignore */ }
        }
      }
      redraw();
    }

    function redraw() {
      render(
        html`
          <h2>Upload an image</h2>
          <div style="margin-bottom:8px;">
            <input id="file" type="file" accept="image/*" />
            <button @click=${upload}>Upload</button>
            <span style="color:#666;font-size:.85em;">${msg}</span>
          </div>
          <div style="color:#888;font-size:.8em;margin-bottom:16px;">
            Accepted: JPEG, PNG, GIF, WebP · max 100 MB
          </div>

          <div style="margin:12px 0;">
            <button @click=${runReport}>Run nightly report now</button>
            <span style="color:#666;font-size:.85em;">${reportMsg}</span>
          </div>

          <h2>Your jobs</h2>
          ${jobs.length === 0 ? html`<p style="color:#888;">No uploads yet.</p>` : ''}
          <ul style="padding:0;">
            ${jobs.map((j) => {
              const pct = progress.get(j.jobId) ?? (j.status === 'COMPLETED' ? 100 : 0);
              const u = urls.get(j.jobId);
              return html`
                <li style="list-style:none;border:1px solid #eee;border-radius:8px;padding:12px;margin:10px 0;">
                  <div style="display:flex;justify-content:space-between;">
                    <b>${j.filename}</b>
                    <span>${j.status}</span>
                  </div>
                  <div style="height:16px;background:#eee;border-radius:5px;overflow:hidden;margin:6px 0;">
                    <div style="height:100%;width:${pct}%;background:#22c55e;transition:width .3s;"></div>
                  </div>
                  ${j.error ? html`<div style="color:#dc2626;">${j.error}</div>` : ''}
                  ${u
                    ? html`<div style="display:flex;gap:16px;align-items:flex-start;margin-top:8px;">
                        <figure style="margin:0;"><figcaption style="font-size:.75em;color:#888;">original</figcaption><img src=${u.originalUrl} style="max-width:180px;max-height:180px;border-radius:6px;" /></figure>
                      </div>`
                    : ''}
                </li>
              `;
            })}
          </ul>
        `,
        container,
      );
    }

    let reportMsg = '';

    async function upload() {
      const input = container.querySelector('#file') as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) { msg = 'pick a file first'; redraw(); return; }
      msg = `uploading ${file.name}…`;
      redraw();
      const b64 = await fileToBase64(file);
      const res = (await api.uploadImage(file.name, file.type, b64)) as
        | { ok: true; jobId: string }
        | { ok: false; error: string };
      if (res.ok) {
        msg = 'accepted ✓';
        input.value = '';
        await load();
      } else {
        msg = `rejected: ${res.error}`;
        redraw();
      }
    }

    async function runReport() {
      const r = (await api.runReportNow()) as { users: number };
      reportMsg = `summary emailed to ${r.users} user(s)`;
      redraw();
    }

    // Live progress via the Realtime channel.
    (async () => {
      try {
        const channel = await api.subscribeJobs();
        const sub = channel.subscribe((m: { jobId: string; status: string; percent: number }) => {
          progress.set(m.jobId, m.percent);
          const job = jobs.find((j) => j.jobId === m.jobId);
          if (job) job.status = m.status;
          if (m.status === 'COMPLETED') { load(); } else { redraw(); }
        });
        await sub.established;
      } catch { /* realtime optional */ }
    })();

    load();
    return container;
  }),
);
