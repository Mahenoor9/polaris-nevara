/**
 * NEVARA Email Notification Service
 * Powered by Resend (https://resend.com)
 *
 * Gracefully no-ops when RESEND_API_KEY is not configured.
 * Set RESEND_API_KEY in .env to enable live email delivery.
 */

import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const FROM_ADDRESS = process.env.EMAIL_FROM ?? "NEVARA MRV <notifications@nevara.earth>";
const APP_URL = process.env.APP_URL ?? "http://localhost:5001";

// Resend client — created lazily so the server starts even without a key
let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(RESEND_API_KEY);
  return resendClient;
}

export function isEmailEnabled(): boolean {
  return Boolean(RESEND_API_KEY);
}

interface SendResult {
  sent: boolean;
  id?: string;
  error?: string;
}

async function send(to: string, subject: string, html: string): Promise<SendResult> {
  const client = getResend();
  if (!client) {
    console.log(`[Email] RESEND_API_KEY not set — skipping email to ${to}: "${subject}"`);
    return { sent: false };
  }
  try {
    const result = await client.emails.send({ from: FROM_ADDRESS, to, subject, html });
    const id = (result as any)?.data?.id ?? (result as any)?.id;
    console.log(`[Email] Sent to ${to}: "${subject}" (id=${id})`);
    return { sent: true, id };
  } catch (err: any) {
    console.error(`[Email] Failed to send to ${to}: ${err?.message}`);
    return { sent: false, error: err?.message };
  }
}

// ─── HTML template helpers ──────────────────────────────────────────────────

function baseTemplate(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title}</title>
<style>
  body { margin: 0; padding: 0; background: #f4f7f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; }
  .wrapper { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .header { background: #065F46; padding: 24px 32px; }
  .header h1 { color: #fff; font-size: 20px; margin: 0; letter-spacing: -0.3px; }
  .header p { color: #a7f3d0; font-size: 12px; margin: 4px 0 0; }
  .body { padding: 32px; }
  .body h2 { font-size: 18px; color: #064E3B; margin: 0 0 12px; }
  .body p { font-size: 14px; line-height: 1.6; color: #374151; margin: 0 0 16px; }
  .kpi-row { display: flex; gap: 16px; margin: 20px 0; }
  .kpi { flex: 1; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 14px 16px; text-align: center; }
  .kpi .val { font-size: 22px; font-weight: 700; color: #065F46; }
  .kpi .lbl { font-size: 11px; color: #6b7280; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .btn { display: inline-block; background: #065F46; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-size: 14px; font-weight: 600; margin: 8px 0 0; }
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  .footer { padding: 16px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; }
  .tag-green { background: #d1fae5; color: #065F46; }
  .tag-red { background: #fee2e2; color: #991b1b; }
  .tag-amber { background: #fef3c7; color: #92400e; }
  .tag-blue { background: #dbeafe; color: #1e40af; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>NEVARA MRV Platform</h1>
    <p>Ecological Intelligence · Blue Carbon Monitoring</p>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="footer">
    NEVARA MRV · This is an automated notification ·
    <a href="${APP_URL}" style="color:#6b7280">Open Platform</a>
  </div>
</div>
</body>
</html>`;
}

// ─── Notification payloads ───────────────────────────────────────────────────

export interface ProjectNotificationPayload {
  projectName: string;
  projectId: string;
  contributorName: string;
  contributorEmail: string;
  ecosystemType?: string;
  areaHa?: number;
  reason?: string;
}

export interface MrvCompletedPayload {
  projectName: string;
  projectId: string;
  runId: string;
  contributorEmail: string;
  contributorName: string;
  ecosystemHealthScore?: number;
  ndviMean?: number;
  riskScore?: number;
}

export interface VerifierAssignedPayload {
  projectName: string;
  projectId: string;
  verifierEmail: string;
  verifierName: string;
  ecosystemType?: string;
  areaHa?: number;
}

// ─── Email functions ─────────────────────────────────────────────────────────

export async function sendProjectApprovedEmail(payload: ProjectNotificationPayload): Promise<SendResult> {
  const { projectName, projectId, contributorName, contributorEmail, ecosystemType, areaHa } = payload;
  const link = `${APP_URL}/intelligence/project/${projectId}`;
  const html = baseTemplate(
    "Project Approved — NEVARA MRV",
    `<h2>Your project has been approved</h2>
    <p>Hi ${contributorName},</p>
    <p>Great news — your project <strong>${projectName}</strong> has been reviewed and approved by our verification team.
    ${ecosystemType ? `This ${ecosystemType} site` : "Your site"}${areaHa ? ` (${areaHa.toFixed(1)} ha)` : ""} is now active in the NEVARA registry and will begin its first satellite monitoring cycle shortly.</p>
    <p><span class="tag tag-green">APPROVED</span></p>
    <hr class="divider"/>
    <p>You can track monitoring progress, view evidence reports, and access your ecological intelligence dashboard from the link below.</p>
    <a href="${link}" class="btn">View Your Project →</a>`,
  );
  return send(contributorEmail, `✅ Project approved: ${projectName}`, html);
}

export async function sendProjectRejectedEmail(payload: ProjectNotificationPayload): Promise<SendResult> {
  const { projectName, projectId, contributorName, contributorEmail, reason } = payload;
  const link = `${APP_URL}/dashboard`;
  const html = baseTemplate(
    "Project Submission Update — NEVARA MRV",
    `<h2>Your submission could not be approved</h2>
    <p>Hi ${contributorName},</p>
    <p>Thank you for submitting <strong>${projectName}</strong> to the NEVARA registry. After review, our verification team was unable to approve this submission at this time.</p>
    ${reason ? `<p><strong>Reason provided:</strong><br/>${reason}</p>` : ""}
    <p><span class="tag tag-red">NOT APPROVED</span></p>
    <hr class="divider"/>
    <p>You are welcome to address the feedback and resubmit. If you have questions, please contact your assigned verifier through the platform.</p>
    <a href="${link}" class="btn">Go to Dashboard →</a>`,
  );
  return send(contributorEmail, `Project submission update: ${projectName}`, html);
}

export async function sendProjectClarificationEmail(payload: ProjectNotificationPayload): Promise<SendResult> {
  const { projectName, projectId, contributorName, contributorEmail, reason } = payload;
  const link = `${APP_URL}/intelligence/project/${projectId}`;
  const html = baseTemplate(
    "Action Required — NEVARA MRV",
    `<h2>Clarification requested for your project</h2>
    <p>Hi ${contributorName},</p>
    <p>Our verification team has reviewed <strong>${projectName}</strong> and requires additional information before the review can be completed.</p>
    ${reason ? `<p><strong>What's needed:</strong><br/>${reason}</p>` : ""}
    <p><span class="tag tag-amber">CLARIFICATION NEEDED</span></p>
    <hr class="divider"/>
    <p>Please log in to the platform to respond to the verifier's comments and provide the requested documentation.</p>
    <a href="${link}" class="btn">Respond to Verifier →</a>`,
  );
  return send(contributorEmail, `⚠️ Clarification needed: ${projectName}`, html);
}

export async function sendMrvCompletedEmail(payload: MrvCompletedPayload): Promise<SendResult> {
  const { projectName, projectId, runId, contributorEmail, contributorName,
    ecosystemHealthScore, ndviMean, riskScore } = payload;
  const link = `${APP_URL}/intelligence/project/${projectId}`;

  const kpiHtml = (ecosystemHealthScore != null || ndviMean != null || riskScore != null)
    ? `<div class="kpi-row">
        ${ecosystemHealthScore != null ? `<div class="kpi"><div class="val">${ecosystemHealthScore}/100</div><div class="lbl">Ecosystem Health</div></div>` : ""}
        ${ndviMean != null ? `<div class="kpi"><div class="val">${ndviMean.toFixed(3)}</div><div class="lbl">Vegetation Health (NDVI)</div></div>` : ""}
        ${riskScore != null ? `<div class="kpi"><div class="val">${riskScore}/100</div><div class="lbl">Ecological Risk Score</div></div>` : ""}
      </div>` : "";

  const html = baseTemplate(
    "Monitoring Cycle Complete — NEVARA MRV",
    `<h2>Monitoring cycle complete</h2>
    <p>Hi ${contributorName},</p>
    <p>A satellite monitoring cycle for <strong>${projectName}</strong> has completed successfully. Your evidence report is ready for review.</p>
    ${kpiHtml}
    <p><span class="tag tag-blue">MONITORING COMPLETE</span></p>
    <hr class="divider"/>
    <p>You can view the full ecological intelligence report, evidence images, and AI insights from the Intelligence Hub.</p>
    <a href="${link}" class="btn">View Evidence Report →</a>`,
  );
  return send(contributorEmail, `📡 Monitoring complete: ${projectName}`, html);
}

export async function sendVerifierAssignedEmail(payload: VerifierAssignedPayload): Promise<SendResult> {
  const { projectName, projectId, verifierEmail, verifierName, ecosystemType, areaHa } = payload;
  const link = `${APP_URL}/operations`;
  const html = baseTemplate(
    "New Project Assigned — NEVARA MRV",
    `<h2>A project has been assigned for your review</h2>
    <p>Hi ${verifierName},</p>
    <p>A new project is waiting for your verification: <strong>${projectName}</strong>${ecosystemType ? ` (${ecosystemType})` : ""}${areaHa ? `, ${areaHa.toFixed(1)} ha` : ""}.</p>
    <p><span class="tag tag-blue">PENDING REVIEW</span></p>
    <hr class="divider"/>
    <p>Please log in to the Operations Dashboard to review the project submission, evidence documentation, and ecological data.</p>
    <a href="${link}" class="btn">Go to Operations Dashboard →</a>`,
  );
  return send(verifierEmail, `🔍 New project for review: ${projectName}`, html);
}

export const emailService = {
  isEnabled: isEmailEnabled,
  sendProjectApproved: sendProjectApprovedEmail,
  sendProjectRejected: sendProjectRejectedEmail,
  sendProjectClarification: sendProjectClarificationEmail,
  sendMrvCompleted: sendMrvCompletedEmail,
  sendVerifierAssigned: sendVerifierAssignedEmail,
};
