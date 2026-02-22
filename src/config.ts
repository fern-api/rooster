import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  slack: {
    botToken: requireEnv("SLACK_BOT_TOKEN"),
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
    appToken: requireEnv("SLACK_APP_TOKEN"),
  },
  // incident.io commented out -- using Slack user groups instead
  // incidentIo: {
  //   apiKey: requireEnv("INCIDENT_IO_API_KEY"),
  //   scheduleIds: {
  //     sdk: requireEnv("INCIDENT_IO_SDK_SCHEDULE_ID"),
  //     docs: requireEnv("INCIDENT_IO_DOCS_SCHEDULE_ID"),
  //   },
  // },
  pylon: {
    apiToken: requireEnv("PYLON_API_TOKEN"),
  },
  devin: {
    slackUserId: requireEnv("DEVIN_SLACK_USER_ID"),
    triageChannel: requireEnv("DEVIN_TRIAGE_CHANNEL"),
  },
  webhook: {
    pylonSecret: requireEnv("PYLON_WEBHOOK_SECRET"),
    port: parseInt(process.env.WEBHOOK_PORT || "3000", 10),
  },
  slashCommand: process.env.SLASH_COMMAND || "/rooster",
};

console.log("[config] loaded configuration:", {
  slashCommand: config.slashCommand,
  webhookPort: config.webhook.port,
  triageChannel: config.devin.triageChannel,
  devinUserId: config.devin.slackUserId,
});
