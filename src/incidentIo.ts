import { config } from "./config";

interface ScheduleUser {
  email: string;
  id: string;
  name: string;
  slack_user_id?: string;
}

interface ScheduleEntry {
  end_at: string;
  entry_id: string;
  start_at: string;
  user: ScheduleUser;
}

interface ScheduleEntriesResponse {
  schedule_entries: {
    final: ScheduleEntry[];
  };
}

/**
 * fetches the current on-call engineer from incident.io
 * returns the slack user id of the on-call engineer, or null if none found
 */
export async function getCurrentOncallEngineer(): Promise<string | null> {
  const now = new Date();
  const windowStart = now.toISOString();
  // look 1 minute into the future to ensure we get the current on-call
  const windowEnd = new Date(now.getTime() + 60000).toISOString();

  const url = new URL("https://api.incident.io/v2/schedule_entries");
  url.searchParams.set("schedule_id", config.incidentIo.scheduleId);
  url.searchParams.set("entry_window_start", windowStart);
  url.searchParams.set("entry_window_end", windowEnd);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.incidentIo.apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `incident.io API error: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as ScheduleEntriesResponse;
  const entries = data.schedule_entries.final;

  if (entries.length === 0) {
    console.warn("No on-call engineer found for the current time window");
    return null;
  }

  // get the first (current) entry
  const currentEntry = entries[0];

  if (!currentEntry.user.slack_user_id) {
    console.warn(
      `on-call engineer ${currentEntry.user.name} does not have a slack user id configured in incident.io`
    );
    return null;
  }

  return currentEntry.user.slack_user_id;
}
