import { App } from "@slack/bolt";
import { config } from "./config";
import { getAccountNamesForIssues, getAssigneeEmailsForIssues, getMyIssues, getNewIssues, getOpenNonNewIssues, getUnrespondedIssues, PylonIssue } from "./pylon";

const CUSTOMER_ALERTS_CHANNEL = "customer-alerts";

const ONCALL_HANDLES = ["docs-on-call", "sdk-on-call", "sales-eng-on-call"];

// Cache for channel names to avoid repeated API calls
const channelNameCache = new Map<string, string>();

// Cache for user group IDs looked up by handle
const userGroupIdCache = new Map<string, string>();

// Cache for Slack user IDs looked up by email
const slackUserIdCache = new Map<string, string>();

/**
 * finds the channel id for #customer-alerts
 */
async function getCustomerAlertsChannelId(app: App): Promise<string> {
  let cursor: string | undefined;

  do {
    const result = await app.client.conversations.list({
      token: config.slack.botToken,
      types: "public_channel",
      limit: 200,
      cursor,
    });

    const channel = result.channels?.find(
      (ch) => ch.name === CUSTOMER_ALERTS_CHANNEL
    );
    if (channel?.id) {
      return channel.id;
    }

    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  throw new Error(`Channel #${CUSTOMER_ALERTS_CHANNEL} not found`);
}

/**
 * looks up Slack user group IDs by handle and returns mention strings
 */
export async function getOncallMentions(app: App): Promise<string> {
  // fetch all user groups once if cache is empty
  if (userGroupIdCache.size === 0) {
    console.log("[oncall] fetching user groups from Slack");
    try {
      const result = await app.client.usergroups.list({
        token: config.slack.botToken,
      });

      for (const group of result.usergroups ?? []) {
        if (group.handle && group.id) {
          userGroupIdCache.set(group.handle, group.id);
        }
      }
      console.log(`[oncall] cached ${userGroupIdCache.size} user groups`);
    } catch (error) {
      console.error("[oncall] error fetching user groups:", error);
    }
  }

  const mentions = ONCALL_HANDLES
    .map((handle) => {
      const groupId = userGroupIdCache.get(handle);
      if (!groupId) {
        console.log(`[oncall] warning: no group ID found for handle "${handle}", using plain text fallback`);
      }
      return groupId ? `<!subteam^${groupId}>` : `@${handle}`;
    })
    .join(" ");

  return mentions + " ";
}

/**
 * fetches channel name for a given channel id, with caching
 */
async function getChannelName(app: App, channelId: string): Promise<string | undefined> {
  if (channelNameCache.has(channelId)) {
    return channelNameCache.get(channelId);
  }

  try {
    const result = await app.client.conversations.info({
      token: config.slack.botToken,
      channel: channelId,
    });

    const name = result.channel?.name;
    if (name) {
      channelNameCache.set(channelId, name);
      return name;
    }
  } catch (error) {
    console.log(`Could not fetch channel name for ${channelId}:`, error);
  }

  return undefined;
}

/**
 * fetches channel names for all issues, returns a map of channel_id -> channel_name
 */
async function getChannelNamesForIssues(app: App, issues: PylonIssue[]): Promise<Map<string, string>> {
  const channelIds = new Set<string>();
  for (const issue of issues) {
    if (issue.slack?.channel_id) {
      channelIds.add(issue.slack.channel_id);
    }
  }

  const channelNames = new Map<string, string>();
  await Promise.all(
    Array.from(channelIds).map(async (channelId) => {
      const name = await getChannelName(app, channelId);
      if (name) {
        channelNames.set(channelId, name);
      }
    })
  );

  return channelNames;
}

/**
 * builds a slack thread link from channel id and message ts
 */
function getSlackThreadUrl(channelId: string, messageTs: string): string {
  // slack deep links use the message ts without the dot
  const tsForUrl = messageTs.replace(".", "");
  return `https://buildwithfern.slack.com/archives/${channelId}/p${tsForUrl}`;
}

/**
 * looks up a Slack user ID by email, with caching
 */
async function getSlackUserIdByEmail(app: App, email: string): Promise<string | undefined> {
  if (slackUserIdCache.has(email)) {
    return slackUserIdCache.get(email);
  }

  try {
    const result = await app.client.users.lookupByEmail({
      token: config.slack.botToken,
      email,
    });

    const userId = result.user?.id;
    if (userId) {
      slackUserIdCache.set(email, userId);
      return userId;
    }
  } catch (error) {
    console.log(`Could not find Slack user for ${email}:`, error);
  }

  return undefined;
}

/**
 * fetches Slack user IDs for all issue assignees
 * resolves pylon user ID -> email -> slack user ID
 * returns a map of pylon_assignee_id -> slack_user_id
 */
async function getAssigneeSlackIdsForIssues(app: App, issues: PylonIssue[]): Promise<Map<string, string>> {
  // first resolve pylon user IDs to emails
  const assigneeEmails = await getAssigneeEmailsForIssues(issues);

  // then resolve emails to slack user IDs
  const slackIds = new Map<string, string>();
  await Promise.all(
    Array.from(assigneeEmails.entries()).map(async ([assigneeId, email]) => {
      const slackId = await getSlackUserIdByEmail(app, email);
      if (slackId) {
        slackIds.set(assigneeId, slackId);
      }
    })
  );

  return slackIds;
}

interface FormatOptions {
  channelNames?: Map<string, string>;
  accountNames?: Map<string, string>;
  assigneeSlackIds?: Map<string, string>;
}

/**
 * formats a single issue for the reminder message
 */
function formatIssue(issue: PylonIssue, index: number, options?: FormatOptions): string {
  // build links - show both slack and pylon when available
  const links: string[] = [];
  if (issue.slack?.channel_id && issue.slack?.message_ts) {
    const ts = issue.slack.message_ts;
    const slackUrl = getSlackThreadUrl(issue.slack.channel_id, ts);
    links.push(`<${slackUrl}|slack>`);
  }
  if (issue.link) {
    links.push(`<${issue.link}|pylon>`);
  }

  const linksPart = links.length > 0 ? ` (${links.join(" | ")})` : "";

  // build description from account name, channel name, requester email, and/or title
  const accountName = issue.account?.id && options?.accountNames?.get(issue.account.id);
  const channelName = issue.slack?.channel_id && options?.channelNames?.get(issue.slack.channel_id);
  const requesterDomain = issue.requester?.email?.split("@")[1];
  const title = issue.title?.trim();

  // Use account name if available, then channel name, then requester email domain
  const customerIdentifier = accountName || (channelName ? `#${channelName}` : undefined) || requesterDomain;
  const descParts = [customerIdentifier, title].filter(Boolean);
  const description = descParts.length > 0 ? ` ${descParts.join(" — ")}` : "";

  // assignee mention
  const assigneeSlackId = issue.assignee?.id && options?.assigneeSlackIds?.get(issue.assignee.id);
  const assigneePart = assigneeSlackId ? ` <@${assigneeSlackId}>` : "";

  return `  ${index + 1}.${description}${linksPart}${assigneePart}`;
}

/**
 * builds the message for unresponded issues (threads with no response at all)
 * returns null if no unresponded issues
 */
export async function getUnrespondedThreadsMessage(app?: App, days: number = 1): Promise<string | null> {
  const unrespondedIssues = await getUnrespondedIssues(days);

  if (unrespondedIssues.length === 0) {
    return null;
  }

  const [channelNames, accountNames, assigneeSlackIds] = await Promise.all([
    app ? getChannelNamesForIssues(app, unrespondedIssues) : Promise.resolve(undefined),
    getAccountNamesForIssues(unrespondedIssues),
    app ? getAssigneeSlackIdsForIssues(app, unrespondedIssues) : Promise.resolve(undefined),
  ]);
  const issueList = unrespondedIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames, assigneeSlackIds })).join("\n");
  const timeframe = days === 1 ? "today" : `the last ${days} days`;

  return `*unresponded threads*\n\nthe following ${unrespondedIssues.length} thread(s) from ${timeframe} have not been responded to:\n\n${issueList}`;
}

/**
 * builds the message for issues assigned to a specific user
 * filters for "new" and "waiting_on_you" states
 * returns null if no issues found
 */
export async function getCheckMineMessage(app: App, days: number, assigneeEmail: string): Promise<string | null> {
  console.log(`[check] getCheckMineMessage: days=${days} assigneeEmail=${assigneeEmail}`);
  const issues = await getMyIssues(days, assigneeEmail);
  console.log(`[check] getCheckMineMessage: found ${issues.length} issues for ${assigneeEmail}`);

  if (issues.length === 0) {
    return null;
  }

  const newIssues = issues.filter((i) => i.state === "new");
  const onYouIssues = issues.filter((i) => i.state === "waiting_on_you");

  const [channelNames, accountNames] = await Promise.all([
    getChannelNamesForIssues(app, issues),
    getAccountNamesForIssues(issues),
  ]);

  const timeframe = days === 1 ? "today" : `the last ${days} days`;
  const sections: string[] = [];

  if (newIssues.length > 0) {
    const list = newIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames })).join("\n");
    sections.push(`*new (${newIssues.length})*\n${list}`);
  }

  if (onYouIssues.length > 0) {
    const list = onYouIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames })).join("\n");
    sections.push(`*waiting on you (${onYouIssues.length})*\n${list}`);
  }

  if (sections.length === 0) {
    return null;
  }

  return `*your issues from ${timeframe}*\n\n${sections.join("\n\n")}`;
}

export interface CheckOptions {
  showNew?: boolean;
  showOpen?: boolean;
  days?: number;
}

/**
 * builds the message for the check command with new and/or open issues
 * returns null if no issues found matching the criteria
 */
export async function getCheckMessage(app?: App, options: CheckOptions = {}): Promise<string | null> {
  console.log(`[check] getCheckMessage: options=${JSON.stringify(options)}`);
  const { showNew = true, showOpen = true, days = 1 } = options;
  const timeframe = days === 1 ? "today" : `the last ${days} days`;

  const [newIssues, openIssues] = await Promise.all([
    showNew ? getNewIssues(days) : Promise.resolve([]),
    showOpen ? getOpenNonNewIssues(days) : Promise.resolve([]),
  ]);

  console.log(`[check] getCheckMessage: found ${newIssues.length} new + ${openIssues.length} open issues`);

  if (newIssues.length === 0 && openIssues.length === 0) {
    return null;
  }

  const allIssues = [...newIssues, ...openIssues];
  const [channelNames, accountNames, assigneeSlackIds] = await Promise.all([
    app ? getChannelNamesForIssues(app, allIssues) : Promise.resolve(undefined),
    getAccountNamesForIssues(allIssues),
    app ? getAssigneeSlackIdsForIssues(app, allIssues) : Promise.resolve(undefined),
  ]);

  const sections: string[] = [];

  if (showNew && newIssues.length > 0) {
    const newList = newIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames, assigneeSlackIds })).join("\n");
    sections.push(`*new issues (${newIssues.length})*\n${newList}`);
  }

  if (showOpen && openIssues.length > 0) {
    const openList = openIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames, assigneeSlackIds })).join("\n");
    sections.push(`*waiting on you (${openIssues.length})*\n${openList}`);
  }

  if (sections.length === 0) {
    return null;
  }

  const header = `*issues from ${timeframe}*\n\n`;
  return header + sections.join("\n\n");
}

/**
 * sends the check message to customer-alerts
 * returns true if message was sent, false if no issues found
 */
export async function sendCheckMessage(app: App, tagOncall: boolean = false, options: CheckOptions = {}): Promise<boolean> {
  console.log(`[check] sendCheckMessage: tagOncall=${tagOncall} options=${JSON.stringify(options)}`);
  const customerAlertsChannelId = await getCustomerAlertsChannelId(app);
  console.log(`[check] resolved #customer-alerts channel id: ${customerAlertsChannelId}`);
  const { showNew = true, showOpen = true, days = 1 } = options;
  const timeframe = days === 1 ? "today" : `the last ${days} days`;

  const [newIssues, openIssues] = await Promise.all([
    showNew ? getNewIssues(days) : Promise.resolve([]),
    showOpen ? getOpenNonNewIssues(days) : Promise.resolve([]),
  ]);

  if (newIssues.length === 0 && openIssues.length === 0) {
    console.log("no issues found matching criteria. skipping message.");
    return false;
  }

  const allIssues = [...newIssues, ...openIssues];
  const [channelNames, accountNames, assigneeSlackIds] = await Promise.all([
    getChannelNamesForIssues(app, allIssues),
    getAccountNamesForIssues(allIssues),
    getAssigneeSlackIdsForIssues(app, allIssues),
  ]);

  const sections: string[] = [];

  if (showNew && newIssues.length > 0) {
    const newList = newIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames, assigneeSlackIds })).join("\n");
    sections.push(`*new issues (${newIssues.length})*\n${newList}`);
  }

  if (showOpen && openIssues.length > 0) {
    const openList = openIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames, assigneeSlackIds })).join("\n");
    sections.push(`*waiting on you (${openIssues.length})*\n${openList}`);
  }

  const oncallMention = tagOncall ? await getOncallMentions(app) : "";

  const header = `*issues from ${timeframe}*\n\n`;
  const message = `${oncallMention}${header}${sections.join("\n\n")}`;

  console.log(`[check] posting message to #customer-alerts (${message.length} chars)`);
  await app.client.chat.postMessage({
    token: config.slack.botToken,
    channel: customerAlertsChannelId,
    text: message,
    unfurl_links: false,
  });

  const totalCount = newIssues.length + openIssues.length;
  console.log(`[check] sent check message: ${newIssues.length} new + ${openIssues.length} open = ${totalCount} issue(s)`);
  return true;
}

/**
 * sends the unresponded threads message to customer-alerts
 * returns true if message was sent, false if no unresponded threads
 */
export async function sendUnrespondedThreadsReminder(app: App, tagOncall: boolean = false, days: number = 1): Promise<boolean> {
  console.log(`[reminder] sendUnrespondedThreadsReminder: tagOncall=${tagOncall} days=${days}`);
  const customerAlertsChannelId = await getCustomerAlertsChannelId(app);
  const unrespondedIssues = await getUnrespondedIssues(days);

  if (unrespondedIssues.length === 0) {
    console.log("[reminder] no unresponded threads found. skipping message.");
    return false;
  }

  const [channelNames, accountNames, assigneeSlackIds] = await Promise.all([
    getChannelNamesForIssues(app, unrespondedIssues),
    getAccountNamesForIssues(unrespondedIssues),
    getAssigneeSlackIdsForIssues(app, unrespondedIssues),
  ]);
  const issueList = unrespondedIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames, assigneeSlackIds })).join("\n");

  const oncallMention = tagOncall ? await getOncallMentions(app) : "";

  const timeframe = days === 1 ? "today" : `the last ${days} days`;
  const message = `*unresponded threads*\n\n${oncallMention}the following ${unrespondedIssues.length} thread(s) from ${timeframe} have not been responded to:\n\n${issueList}`;

  await app.client.chat.postMessage({
    token: config.slack.botToken,
    channel: customerAlertsChannelId,
    text: message,
    unfurl_links: false,
  });

  console.log(`[reminder] sent unresponded threads message for ${unrespondedIssues.length} issue(s)`);
  return true;
}
