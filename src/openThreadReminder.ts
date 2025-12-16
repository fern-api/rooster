import { App } from "@slack/bolt";
import { config } from "./config";
import { getAllOncallEngineers } from "./incidentIo";
import { getAccountNamesForIssues, getOpenIssues, getUnrespondedIssues, PylonIssue } from "./pylon";

const CUSTOMER_ALERTS_CHANNEL = "customer-alerts";

// Cache for channel names to avoid repeated API calls
const channelNameCache = new Map<string, string>();

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

interface FormatOptions {
  channelNames?: Map<string, string>;
  accountNames?: Map<string, string>;
}

/**
 * formats a single issue for the reminder message
 */
function formatIssue(issue: PylonIssue, index: number, options?: FormatOptions): string {
  const stateLabel = formatState(issue.state);

  // build links - show both slack and pylon when available
  const links: string[] = [];
  if (issue.slack?.channel_id && issue.slack?.message_ts) {
    const ts = issue.slack.thread_ts || issue.slack.message_ts;
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

  return `  ${index + 1}.${description}${linksPart} (${stateLabel})`;
}

/**
 * formats issue state for display
 */
function formatState(state: string): string {
  const stateLabels: Record<string, string> = {
    new: "new",
    waiting_on_you: "waiting on you",
    waiting_on_customer: "waiting on customer",
    on_hold: "on hold",
  };
  return stateLabels[state] || state;
}

/**
 * builds the reminder message for open issues (without tagging on-call)
 * returns null if no open issues
 */
export async function getOpenThreadReminderMessage(app?: App): Promise<string | null> {
  const openIssues = await getOpenIssues();

  if (openIssues.length === 0) {
    return null;
  }

  const [channelNames, accountNames] = await Promise.all([
    app ? getChannelNamesForIssues(app, openIssues) : Promise.resolve(undefined),
    getAccountNamesForIssues(openIssues),
  ]);
  const issueList = openIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames })).join("\n");

  return `*end of day reminder*\n\nthe following ${openIssues.length} issue(s) from today are still open:\n\n${issueList}\n\nplease review and resolve these issues.`;
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

  const [channelNames, accountNames] = await Promise.all([
    app ? getChannelNamesForIssues(app, unrespondedIssues) : Promise.resolve(undefined),
    getAccountNamesForIssues(unrespondedIssues),
  ]);
  const issueList = unrespondedIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames })).join("\n");
  const timeframe = days === 1 ? "today" : `the last ${days} days`;

  return `*unresponded threads*\n\nthe following ${unrespondedIssues.length} thread(s) from ${timeframe} have not been responded to:\n\n${issueList}`;
}

/**
 * sends the end-of-day reminder with open issues to customer-alerts
 */
export async function sendOpenThreadReminder(app: App): Promise<void> {
  const customerAlertsChannelId = await getCustomerAlertsChannelId(app);
  const openIssues = await getOpenIssues();

  if (openIssues.length === 0) {
    console.log("no open issues found. skipping reminder.");
    return;
  }

  const [channelNames, accountNames] = await Promise.all([
    getChannelNamesForIssues(app, openIssues),
    getAccountNamesForIssues(openIssues),
  ]);
  const issueList = openIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames })).join("\n");

  const oncallEngineerIds = await getAllOncallEngineers();
  const oncallMention =
    oncallEngineerIds.length > 0
      ? oncallEngineerIds.map((id) => `<@${id}>`).join(" ") + " "
      : "on-call engineers ";

  const message = `*end of day reminder*\n\n${oncallMention}the following ${openIssues.length} issue(s) from today are still open:\n\n${issueList}\n\nplease review and resolve these issues.`;

  await app.client.chat.postMessage({
    token: config.slack.botToken,
    channel: customerAlertsChannelId,
    text: message,
    unfurl_links: false,
  });

  console.log(`sent reminder for ${openIssues.length} open issue(s).`);
}

/**
 * sends the unresponded threads message to customer-alerts
 * returns true if message was sent, false if no unresponded threads
 */
export async function sendUnrespondedThreadsReminder(app: App, tagOncall: boolean = false, days: number = 1): Promise<boolean> {
  const customerAlertsChannelId = await getCustomerAlertsChannelId(app);
  const unrespondedIssues = await getUnrespondedIssues(days);

  if (unrespondedIssues.length === 0) {
    console.log("no unresponded threads found. skipping message.");
    return false;
  }

  const [channelNames, accountNames] = await Promise.all([
    getChannelNamesForIssues(app, unrespondedIssues),
    getAccountNamesForIssues(unrespondedIssues),
  ]);
  const issueList = unrespondedIssues.map((issue, index) => formatIssue(issue, index, { channelNames, accountNames })).join("\n");

  let oncallMention = "";
  if (tagOncall) {
    const oncallEngineerIds = await getAllOncallEngineers();
    oncallMention =
      oncallEngineerIds.length > 0
        ? oncallEngineerIds.map((id) => `<@${id}>`).join(" ") + " "
        : "";
  }

  const timeframe = days === 1 ? "today" : `the last ${days} days`;
  const message = `*unresponded threads*\n\n${oncallMention}the following ${unrespondedIssues.length} thread(s) from ${timeframe} have not been responded to:\n\n${issueList}`;

  await app.client.chat.postMessage({
    token: config.slack.botToken,
    channel: customerAlertsChannelId,
    text: message,
    unfurl_links: false,
  });

  console.log(`sent unresponded threads message for ${unrespondedIssues.length} issue(s).`);
  return true;
}
