import { createConfiguredEmailChannels } from "../src/server/emailChannels.js";
import { createOperationalAlertSender } from "../src/server/operationalAlerts.js";

if (process.env.ALLOW_LIVE_ALERT_TEST !== "true") {
  throw new Error("Refusing to send email without ALLOW_LIVE_ALERT_TEST=true");
}

const recipient = process.env.SECURITY_CONTACT_EMAIL?.trim();
if (!recipient) throw new Error("SECURITY_CONTACT_EMAIL is not configured");

let deliveredChannel: string | undefined;
const sender = createOperationalAlertSender({
  channels: createConfiguredEmailChannels(),
  recipient,
  onEvent: event => {
    if (event.event === "alert-sent") deliveredChannel = event.channel;
  },
});

const occurredAt = new Date().toISOString();
await sender.send({
  kind: "test",
  subject: "[AtomFlow] 告警链路真实测试",
  message: "这是一封受控的生产告警链路测试邮件。收到此邮件表示 Resend→SMTP 投递链路可用，无需采取故障处理操作。",
  occurredAt,
});

process.stdout.write(JSON.stringify({ sent: true, channel: deliveredChannel, occurredAt }) + "\n");
