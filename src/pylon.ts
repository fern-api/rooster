import { config } from "./config";

const PYLON_API_BASE = "https://api.usepylon.com";

export interface PylonIssue {
  id: string;
  number: number;
  title: string;
  state: string;
  created_at: string;
  link?: string;
  first_response_time?: string | null;
  account?: {
    id: string;
    name?: string;
  };
  assignee?: {
    email: string;
    id: string;
  };
  requester?: {
    email: string;
    id: string;
  };
  body_html?: string;
  attachment_urls?: string[];
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

const OPEN_NON_NEW_STATES = ["waiting_on_you"];

// Cache for account names to avoid repeated API calls
const accountNameCache = new Map<string, string>();

// Cache for Pylon user emails looked up by user id
const pylonUserEmailCache = new Map<string, string>();

interface PylonAccount {
  id: string;
  name: string;
}

/**
 * fetches account details from pylon by account id
 */
async function fetchAccount(accountId: string): Promise<PylonAccount | null> {
  if (accountNameCache.has(accountId)) {
    console.log(`[pylon] cache hit for account ${accountId}: ${accountNameCache.get(accountId)}`);
    return { id: accountId, name: accountNameCache.get(accountId)! };
  }

  console.log(`[pylon] fetching account ${accountId}`);
  try {
    const response = await fetch(`${PYLON_API_BASE}/accounts/${accountId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.pylon.apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(`Could not fetch account ${accountId}: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { data?: { name?: string } };
    if (data.data?.name) {
      accountNameCache.set(accountId, data.data.name);
      return { id: accountId, name: data.data.name };
    }
  } catch (error) {
    console.log(`Error fetching account ${accountId}:`, error);
  }

  return null;
}

/**
 * fetches a single issue by ID from the Pylon API
 */
export async function fetchIssueById(issueId: string): Promise<PylonIssue | null> {
  console.log(`[pylon] fetching issue ${issueId}`);
  try {
    const response = await fetch(`${PYLON_API_BASE}/issues/${issueId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.pylon.apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(`[pylon] could not fetch issue ${issueId}: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { data?: PylonIssue };
    return data.data ?? null;
  } catch (error) {
    console.log(`[pylon] error fetching issue ${issueId}:`, error);
    return null;
  }
}

/**
 * fetches account names for all issues, returns a map of account_id -> account_name
 */
export async function getAccountNamesForIssues(issues: PylonIssue[]): Promise<Map<string, string>> {
  const accountIds = new Set<string>();
  for (const issue of issues) {
    if (issue.account?.id) {
      accountIds.add(issue.account.id);
    }
  }

  const accountNames = new Map<string, string>();
  await Promise.all(
    Array.from(accountIds).map(async (accountId) => {
      const account = await fetchAccount(accountId);
      if (account?.name) {
        accountNames.set(accountId, account.name);
      }
    })
  );

  return accountNames;
}

/**
 * fetches a pylon user's email by their user id, with caching
 */
async function fetchPylonUserEmail(userId: string): Promise<string | null> {
  if (pylonUserEmailCache.has(userId)) {
    console.log(`[pylon] cache hit for user email ${userId}: ${pylonUserEmailCache.get(userId)}`);
    return pylonUserEmailCache.get(userId)!;
  }

  console.log(`[pylon] fetching user email for ${userId}`);
  try {
    const response = await fetch(`${PYLON_API_BASE}/users/${userId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.pylon.apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(`Could not fetch pylon user ${userId}: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { data?: { email?: string } };
    if (data.data?.email) {
      pylonUserEmailCache.set(userId, data.data.email);
      return data.data.email;
    }
  } catch (error) {
    console.log(`Error fetching pylon user ${userId}:`, error);
  }

  return null;
}

/**
 * fetches assignee emails for all issues, returns a map of assignee_id -> email
 */
export async function getAssigneeEmailsForIssues(issues: PylonIssue[]): Promise<Map<string, string>> {
  const assigneeIds = new Set<string>();
  for (const issue of issues) {
    if (issue.assignee?.id) {
      assigneeIds.add(issue.assignee.id);
    }
  }

  const assigneeEmails = new Map<string, string>();
  await Promise.all(
    Array.from(assigneeIds).map(async (assigneeId) => {
      const email = await fetchPylonUserEmail(assigneeId);
      if (email) {
        assigneeEmails.set(assigneeId, email);
      }
    })
  );

  return assigneeEmails;
}

/**
 * fetches issues from pylon created within the last N days
 */
async function fetchIssues(days: number = 1): Promise<PylonIssue[]> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTime = new Date(startOfToday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const endOfDay = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

  const url = new URL(`${PYLON_API_BASE}/issues`);
  url.searchParams.set("start_time", startTime.toISOString());
  url.searchParams.set("end_time", endOfDay.toISOString());

  console.log(`[pylon] fetching issues: days=${days} start=${startTime.toISOString()} end=${endOfDay.toISOString()}`);
  const fetchStart = Date.now();

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.pylon.apiToken}`,
      "Content-Type": "application/json",
    },
  });

  const elapsed = Date.now() - fetchStart;

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[pylon] api error (${elapsed}ms): ${response.status} ${response.statusText}`, errorBody);
    throw new Error(`pylon api error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const data = (await response.json()) as PylonSearchResponse;
  if (!data.data) {
    console.error(`[pylon] unexpected response (${elapsed}ms):`, JSON.stringify(data));
    return [];
  }

  const stateCounts = data.data.reduce((acc, issue) => {
    acc[issue.state] = (acc[issue.state] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`[pylon] fetched ${data.data.length} issues in ${elapsed}ms, states: ${JSON.stringify(stateCounts)}`);

  return data.data;
}

/**
 * fetches issues with state "new" (unassigned) from the last N days
 */
export async function getNewIssues(days: number = 1): Promise<PylonIssue[]> {
  const issues = await fetchIssues(days);
  return issues.filter((issue) => issue.state === "new");
}

/**
 * fetches open issues with state "waiting_on_you" from the last N days
 */
export async function getOpenNonNewIssues(days: number = 1): Promise<PylonIssue[]> {
  const issues = await fetchIssues(days);
  return issues.filter((issue) => OPEN_NON_NEW_STATES.includes(issue.state));
}

/**
 * fetches issues assigned to a specific email with state "new" or "waiting_on_you"
 * from the last N days
 */
export async function getMyIssues(days: number, assigneeEmail: string): Promise<PylonIssue[]> {
  console.log(`[pylon] getMyIssues: days=${days} assigneeEmail=${assigneeEmail}`);
  const issues = await fetchIssues(days);
  const relevantStates = ["new", ...OPEN_NON_NEW_STATES];

  // filter by relevant states first
  const stateFiltered = issues.filter((issue) => relevantStates.includes(issue.state));
  console.log(`[pylon] getMyIssues: ${stateFiltered.length}/${issues.length} issues in relevant states`);

  // resolve assignee emails
  const emailMap = new Map<string, string>();
  await Promise.all(
    Array.from(new Set(stateFiltered.map((i) => i.assignee?.id).filter(Boolean) as string[])).map(async (id) => {
      const email = await fetchPylonUserEmail(id);
      if (email) {
        emailMap.set(id, email);
      }
    })
  );

  // filter by matching assignee email
  const myIssues = stateFiltered.filter((issue) => {
    if (!issue.assignee?.id) return false;
    const email = emailMap.get(issue.assignee.id);
    return email?.toLowerCase() === assigneeEmail.toLowerCase();
  });
  console.log(`[pylon] getMyIssues: found ${myIssues.length} issues assigned to ${assigneeEmail}`);
  return myIssues;
}

/**
 * fetches issues from the last N days that have not been responded to at all
 * filters for state = "new" AND first_response_time = null
 * (issues with first_response_time set are customer replies to Fern-initiated threads)
 */
export async function getUnrespondedIssues(days: number = 1): Promise<PylonIssue[]> {
  const issues = await fetchIssues(days);
  const newStateIssues = issues.filter((issue) => issue.state === "new");
  const trulyUnresponded = newStateIssues.filter((issue) => issue.first_response_time == null);

  console.log(`\n=== UNRESPONDED ISSUES DEBUG ===`);
  console.log(`Total issues (last ${days} day(s)): ${issues.length}`);
  console.log(`Issues with state "new": ${newStateIssues.length}`);
  console.log(`Truly unresponded (no first_response_time): ${trulyUnresponded.length}`);

  // Log issues that were filtered out (customer replies to Fern threads)
  const filteredOut = newStateIssues.filter((issue) => issue.first_response_time != null);
  if (filteredOut.length > 0) {
    console.log(`\nFiltered out ${filteredOut.length} issue(s) (customer replies to Fern-initiated threads):`);
    for (const issue of filteredOut) {
      console.log(`  - #${issue.number}: ${issue.title || "(no title)"} (first_response_time: ${issue.first_response_time})`);
    }
  }

  console.log(`\nIncluded issues:`);
  for (const issue of trulyUnresponded) {
    let accountInfo = "no account";
    if (issue.account) {
      accountInfo = issue.account.name ? `account: ${issue.account.name}` : `account id: ${issue.account.id} (no name)`;
    }
    const requesterInfo = issue.requester?.email ? `requester: ${issue.requester.email}` : "no requester";
    const channelInfo = issue.slack?.channel_id ? `channel: ${issue.slack.channel_id}` : "no channel";
    console.log(`  - #${issue.number}: ${issue.title || "(no title)"} (${accountInfo}, ${requesterInfo}, ${channelInfo})`);
  }
  console.log(`\n=== END DEBUG ===\n`);

  return trulyUnresponded;
}

