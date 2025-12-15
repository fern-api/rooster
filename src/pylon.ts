import { config } from "./config";

const PYLON_API_BASE = "https://api.usepylon.com";

export interface PylonIssue {
  id: string;
  number: number;
  title: string;
  state: string;
  created_at: string;
  account?: {
    id: string;
    name?: string;
  };
  requester?: {
    email: string;
    id: string;
  };
  slack?: {
    channel_id: string;
    message_ts: string;
    workspace_id: string;
  };
}

interface PylonSearchResponse {
  data: PylonIssue[];
  request_id: string;
  pagination?: {
    cursor?: string;
  };
}

const OPEN_STATES = ["new", "waiting_on_you", "waiting_on_customer", "on_hold"];

/**
 * fetches open issues from pylon created today
 */
export async function getOpenIssues(): Promise<PylonIssue[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const url = new URL(`${PYLON_API_BASE}/issues`);
  url.searchParams.set("start_time", startOfDay.toISOString());
  url.searchParams.set("end_time", endOfDay.toISOString());

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.pylon.apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("pylon api error response:", errorBody);
    throw new Error(`pylon api error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const data = (await response.json()) as PylonSearchResponse;

  // filter to only open issues
  return data.data.filter((issue) => OPEN_STATES.includes(issue.state));
}

