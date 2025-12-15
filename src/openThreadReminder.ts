import { App } from "@slack/bolt";
import { config } from "./config";
import { getAllOncallEngineers } from "./incidentIo";

const CHECK_MARK_EMOJI = "white_check_mark";
const CUSTOMER_ALERTS_CHANNEL = "customer-alerts";

interface ThreadMessage {
  ts: string;
  text: string;
  user?: string;
  permalink?: string;
}

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
 * fetches messages from #customer-alerts posted today
 */
async function getTodaysMessages(
  app: App,
  channelId: string
): Promise<ThreadMessage[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const oldestTs = (startOfDay.getTime() / 1000).toString();

  const result = await app.client.conversations.history({
    token: config.slack.botToken,
    channel: channelId,
    oldest: oldestTs,
    limit: 200,
  });

  if (!result.messages) {
    return [];
  }

  // filter to only parent messages (not thread replies)
  return result.messages
    .filter((msg) => !msg.thread_ts || msg.thread_ts === msg.ts)
    .map((msg) => ({
      ts: msg.ts!,
      text: msg.text || "",
      user: msg.user,
    }));
}

/**
 * checks if a message has been marked with ✅
 */
async function hasCheckMarkReaction(
  app: App,
  channelId: string,
  messageTs: string
): Promise<boolean> {
  const result = await app.client.reactions.get({
    token: config.slack.botToken,
    channel: channelId,
    timestamp: messageTs,
  });

  if (!result.message || !("reactions" in result.message)) {
    return false;
  }

  const reactions = result.message.reactions || [];
  return reactions.some((reaction) => reaction.name === CHECK_MARK_EMOJI);
}

/**
 * gets the permalink for a message
 */
async function getMessagePermalink(
  app: App,
  channelId: string,
  messageTs: string
): Promise<string> {
  const result = await app.client.chat.getPermalink({
    token: config.slack.botToken,
    channel: channelId,
    message_ts: messageTs,
  });

  return result.permalink || "";
}

/**
 * finds all open (unmarked) threads from today
 */
async function findOpenThreads(
  app: App,
  channelId: string
): Promise<ThreadMessage[]> {
  const messages = await getTodaysMessages(app, channelId);
  const openThreads: ThreadMessage[] = [];

  for (const message of messages) {
    const hasCheckMark = await hasCheckMarkReaction(app, channelId, message.ts);
    if (!hasCheckMark) {
      const permalink = await getMessagePermalink(app, channelId, message.ts);
      openThreads.push({
        ...message,
        permalink,
      });
    }
  }

  return openThreads;
}

/**
 * sends the end-of-day reminder with open threads
 */
export async function sendOpenThreadReminder(app: App): Promise<void> {
  const channelId = await getCustomerAlertsChannelId(app);
  const openThreads = await findOpenThreads(app, channelId);

  if (openThreads.length === 0) {
    console.log("no open threads found. skipping reminder.");
    return;
  }

  const oncallEngineerIds = await getAllOncallEngineers();

  const threadList = openThreads
    .map((thread, index) => {
      const preview =
        thread.text.length > 100
          ? thread.text.substring(0, 100) + "..."
          : thread.text;
      return `${index + 1}. <${thread.permalink}|thread>: ${preview}`;
    })
    .join("\n");

  const oncallMention =
    oncallEngineerIds.length > 0
      ? oncallEngineerIds.map((id) => `<@${id}>`).join(" ")
      : "on-call engineers";

  const message = `🐓 *end of day reminder*\n\n${oncallMention} the following ${openThreads.length} thread(s) in <#${channelId}> have not been marked with ✅:\n\n${threadList}\n\nplease review and resolve these threads.`;

  await app.client.chat.postMessage({
    token: config.slack.botToken,
    channel: channelId,
    text: message,
    unfurl_links: false,
  });

  console.log(`sent reminder for ${openThreads.length} open thread(s).`);
}
