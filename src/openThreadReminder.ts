import { App } from "@slack/bolt";
import { config } from "./config";
import { getAllOncallEngineers } from "./incidentIo";
import { getOpenIssues, PylonIssue } from "./pylon";

const CUSTOMER_ALERTS_CHANNEL = "customer-alerts";

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
 * builds a slack thread link from channel id and message ts
 */
function getSlackThreadUrl(channelId: string, messageTs: string): string {
  // slack deep links use the message ts without the dot
  const tsForUrl = messageTs.replace(".", "");
  return `https://buildwithfern.slack.com/archives/${channelId}/p${tsForUrl}`;
}

/**
 * formats a single issue for the reminder message
 */
function formatIssue(issue: PylonIssue, index: number): string {
  const stateLabel = formatState(issue.state);

  // build the link - prefer slack thread, fall back to issue number
  let link: string;
  if (issue.slack?.channel_id && issue.slack?.message_ts) {
    const slackUrl = getSlackThreadUrl(issue.slack.channel_id, issue.slack.message_ts);
    link = `<${slackUrl}|#${issue.number}>`;
  } else {
    link = `#${issue.number}`;
  }

  // only include account name if we have one
  const accountName = issue.account?.name || issue.requester?.email;
  const accountPart = accountName ? ` — ${accountName}` : "";

  return `  ${index + 1}. ${link}${accountPart} — ${issue.title} (${stateLabel})`;
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
export async function getOpenThreadReminderMessage(): Promise<string | null> {
  const openIssues = await getOpenIssues();

  if (openIssues.length === 0) {
    return null;
  }

  const issueList = openIssues.map((issue, index) => formatIssue(issue, index)).join("\n");

  return `🐓 *end of day reminder*\n\nthe following ${openIssues.length} issue(s) from today are still open:\n\n${issueList}\n\nplease review and resolve these issues.`;
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

  const issueList = openIssues.map((issue, index) => formatIssue(issue, index)).join("\n");

  const oncallEngineerIds = await getAllOncallEngineers();
  const oncallMention =
    oncallEngineerIds.length > 0
      ? oncallEngineerIds.map((id) => `<@${id}>`).join(" ") + " "
      : "on-call engineers ";

  const message = `🐓 *end of day reminder*\n\n${oncallMention}the following ${openIssues.length} issue(s) from today are still open:\n\n${issueList}\n\nplease review and resolve these issues.`;

  await app.client.chat.postMessage({
    token: config.slack.botToken,
    channel: customerAlertsChannelId,
    text: message,
    unfurl_links: false,
  });

  console.log(`sent reminder for ${openIssues.length} open issue(s).`);
}
