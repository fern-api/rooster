import { App } from "@slack/bolt";
import { config } from "./config";

const DEVIN_DOCS_RUNS_CHANNEL = "C09NULAN2H3";
const CUSTOMER_SUPPORT_CHANNEL = "C052DFWVCG6";

// Cache for the Devin bot user ID
let devinBotUserId: string | null = null;

/**
 * finds the Devin bot user ID by searching for the app named "Devin"
 */
async function getDevinBotUserId(app: App): Promise<string | null> {
  if (devinBotUserId) {
    return devinBotUserId;
  }

  let cursor: string | undefined;
  do {
    const result = await app.client.users.list({
      token: config.slack.botToken,
      limit: 200,
      cursor,
    });

    const devinUser = result.members?.find(
      (member) =>
        member.is_bot &&
        (member.name?.toLowerCase() === "devin" ||
          member.profile?.display_name?.toLowerCase() === "devin" ||
          member.real_name?.toLowerCase() === "devin")
    );

    if (devinUser?.id) {
      devinBotUserId = devinUser.id;
      return devinBotUserId;
    }

    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  return null;
}

interface ThreadMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
}

/**
 * fetches all messages in a thread
 */
async function fetchThreadMessages(
  app: App,
  channelId: string,
  threadTs: string
): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await app.client.conversations.replies({
      token: config.slack.botToken,
      channel: channelId,
      ts: threadTs,
      limit: 200,
      cursor,
    });

    if (result.messages) {
      messages.push(...result.messages);
    }

    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  return messages;
}

/**
 * resolves a slack user ID to a display name
 */
async function resolveUserName(
  app: App,
  userId: string
): Promise<string> {
  try {
    const result = await app.client.users.info({
      token: config.slack.botToken,
      user: userId,
    });
    return (
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId
    );
  } catch {
    return userId;
  }
}

/**
 * builds the triage prompt from thread messages
 */
async function buildTriagePrompt(
  app: App,
  messages: ThreadMessage[],
  sourceThreadUrl: string
): Promise<string> {
  // resolve user names for all messages
  const userIds = new Set<string>();
  for (const msg of messages) {
    if (msg.user) {
      userIds.add(msg.user);
    }
  }

  const userNames = new Map<string, string>();
  await Promise.all(
    Array.from(userIds).map(async (userId) => {
      const name = await resolveUserName(app, userId);
      userNames.set(userId, name);
    })
  );

  // format thread messages
  const formattedMessages = messages
    .map((msg) => {
      const sender = msg.user
        ? userNames.get(msg.user) || msg.user
        : msg.bot_id
          ? `bot:${msg.bot_id}`
          : "unknown";
      return `[${sender}]: ${msg.text || "(no text)"}`;
    })
    .join("\n");

  return `You are triaging a customer support thread from #customer-support.

Source thread: ${sourceThreadUrl}

Here is the full thread:

${formattedMessages}

Please:
1. Determine which on-call team should handle this: @sdk-on-call, @docs-on-call, or @sales-eng-on-call. Tag them in your response.
2. Based on the issue, decide on next steps:
   a. If this can be resolved with a support response, draft a message for the on-call to send to the customer.
   b. If this requires a code change, identify the relevant repo and draft a PR to fix the issue.`;
}

/**
 * builds a slack thread URL from channel ID and thread timestamp
 */
function buildThreadUrl(channelId: string, threadTs: string): string {
  const tsForUrl = threadTs.replace(".", "");
  return `https://buildwithfern.slack.com/archives/${channelId}/p${tsForUrl}`;
}

/**
 * opens a Devin thread in #devin-docs-runs with the triage prompt
 */
async function openDevinThread(
  app: App,
  prompt: string
): Promise<{ ok: boolean; error?: string }> {
  const devinUserId = await getDevinBotUserId(app);

  if (!devinUserId) {
    return { ok: false, error: "could not find the Devin bot user in this workspace" };
  }

  const message = `<@${devinUserId}> ${prompt}`;

  try {
    await app.client.chat.postMessage({
      token: config.slack.botToken,
      channel: DEVIN_DOCS_RUNS_CHANNEL,
      text: message,
      unfurl_links: false,
    });
    return { ok: true };
  } catch (error) {
    console.error("error posting triage message to #devin-docs-runs:", error);
    return { ok: false, error: "failed to post message to #devin-docs-runs" };
  }
}

/**
 * replies in the original thread with a status message
 */
async function replyInThread(
  app: App,
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  try {
    await app.client.chat.postMessage({
      token: config.slack.botToken,
      channel: channelId,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
    });
  } catch (error) {
    console.error("error replying in thread:", error);
  }
}

/**
 * registers the triage app_mention listener
 * triggered by mentioning @rooster with "triage" in a #customer-support thread
 */
export function registerTriageListener(app: App): void {
  app.event("app_mention", async ({ event, say }) => {
    // only respond to mentions that include "triage"
    const text = event.text?.toLowerCase() || "";
    if (!text.includes("triage")) {
      return;
    }

    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;

    // must be in #customer-support
    if (channelId !== CUSTOMER_SUPPORT_CHANNEL) {
      await say({
        text: "triage only works in <#" + CUSTOMER_SUPPORT_CHANNEL + "> threads.",
        thread_ts: threadTs,
      });
      return;
    }

    // must be in a thread (thread_ts present means this mention is inside a thread)
    if (!event.thread_ts) {
      await say({
        text: "please mention me with `triage` inside a support thread, not at the top level.",
        thread_ts: event.ts,
      });
      return;
    }

    // acknowledge
    await replyInThread(app, channelId, threadTs, "triaging this thread...");

    // fetch thread messages
    const messages = await fetchThreadMessages(app, channelId, threadTs);
    if (messages.length === 0) {
      await replyInThread(app, channelId, threadTs, "couldn't fetch any messages from this thread.");
      return;
    }

    // build source thread URL and prompt
    const sourceThreadUrl = buildThreadUrl(channelId, threadTs);
    const prompt = await buildTriagePrompt(app, messages, sourceThreadUrl);

    // open Devin thread in #devin-docs-runs
    const result = await openDevinThread(app, prompt);

    if (!result.ok) {
      await replyInThread(app, channelId, threadTs, `triage failed: ${result.error}`);
      return;
    }

    await replyInThread(
      app,
      channelId,
      threadTs,
      `triage started — Devin is analyzing this thread in <#${DEVIN_DOCS_RUNS_CHANNEL}>`
    );
  });
}
