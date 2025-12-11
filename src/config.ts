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
    scheduleId: requireEnv("INCIDENT_IO_SCHEDULE_ID"),
  },
};
