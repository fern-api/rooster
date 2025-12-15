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
  incidentIo: {
    apiKey: requireEnv("INCIDENT_IO_API_KEY"),
    scheduleIds: {
      sdk: requireEnv("INCIDENT_IO_SDK_SCHEDULE_ID"),
      docs: requireEnv("INCIDENT_IO_DOCS_SCHEDULE_ID"),
      askFern: requireEnv("INCIDENT_IO_ASK_FERN_SCHEDULE_ID"),
    },
  },
};
