import nodemailer from "nodemailer";
import { Resend } from "resend";
import type { EmailChannel, EmailMessage } from "./operationalAlerts.js";

type EmailEnvironment = {
  RESEND_API_KEY?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
};

const buildEmailPayload = (message: EmailMessage) => ({
  to: message.to,
  subject: message.subject,
  ...(message.html ? { html: message.html } : { text: message.text ?? "" }),
});

/**
 * Build the ordered transactional and operational email providers.
 *
 * Resend is preferred, with Gmail SMTP as an independent fallback. Resend API
 * rejections resolve with `{ data: null, error }`, so checking `result.error` is
 * required; otherwise callers would report success for a message that was never
 * accepted.
 */
export const createConfiguredEmailChannels = (
  environment: EmailEnvironment = process.env,
): EmailChannel[] => {
  const resend = environment.RESEND_API_KEY ? new Resend(environment.RESEND_API_KEY) : null;
  const smtpTransporter = environment.SMTP_USER && environment.SMTP_PASS
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: environment.SMTP_USER, pass: environment.SMTP_PASS },
      })
    : null;

  return [
    ...(resend ? [{
      name: "resend" as const,
      send: async (message: EmailMessage) => {
        const result = await resend.emails.send({
          from: "AtomFlow <noreply@atomflow.cloud>",
          ...buildEmailPayload(message),
        });
        if (result.error) throw new Error(`Resend rejected the message: ${result.error.message}`);
      },
    }] : []),
    ...(smtpTransporter ? [{
      name: "smtp" as const,
      send: async (message: EmailMessage) => {
        await smtpTransporter.sendMail({
          from: `AtomFlow <${environment.SMTP_USER}>`,
          ...buildEmailPayload(message),
        });
      },
    }] : []),
  ];
};
