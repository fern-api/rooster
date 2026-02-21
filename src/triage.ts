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
  messages: ThreadMessage[]
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

  const prompt = `You are triaging a customer support thread from #customer-support.

Here is the full thread:

${formattedMessages}

Please:
1. Determine which on-call team should handle this: @sdk-on-call, @docs-on-call, or @sales-eng-on-call. Tag them in your response.
2. Based on the issue, decide on next steps:
   a. If this can be resolved with a support response, draft a message for the on-call to send to the customer.
   b. If this requires a code change, identify the relevant repo and draft a PR to fix the issue.`;

  return prompt;
}

/**
 * opens a Devin thread in #devin-docs-runs with the triage prompt
 */
async function openDevinThread(
  app: App,
  prompt: string,
  sourceThreadUrl: string
): Promise<{ ok: boolean; error?: string }> {
  const devinUserId = await getDevinBotUserId(app);

  if (!devinUserId) {
    return { ok: false, error: "could not find the Devin bot user in this workspace" };
  }

  const message = `<@${devinUserId}> ${prompt}\n\n_source thread: ${sourceThreadUrl}_`;

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
 * parses a slack thread URL to extract channel ID and thread timestamp
 * supports formats like:
 *   https://buildwithfern.slack.com/archives/C052DFWVCG6/p1234567890123456
 *   https://app.slack.com/client/T.../C052DFWVCG6/thread/C052DFWVCG6-1234567890.123456
 */
function parseThreadUrl(url: string): { channelId: string; threadTs: string } | null {
  // format: /archives/{channelId}/p{ts_without_dot}
  const archiveMatch = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (archiveMatch) {
    const channelId = archiveMatch[1];
    const threadTs = `${archiveMatch[2]}.${archiveMatch[3]}`;
    return { channelId, threadTs };
  }

  // format: /thread/{channelId}-{ts_with_dot}
  const threadMatch = url.match(/\/thread\/([A-Z0-9]+)-(\d+\.\d+)/);
  if (threadMatch) {
    return { channelId: threadMatch[1], threadTs: threadMatch[2] };
  }

  return null;
}

/**
 * handles the /rooster triage command
 * accepts a slack thread URL from #customer-support as an argument
 * usage: /rooster triage <thread_url>
 */
export async function handleTriage(
  app: App,
  args: string[]
): Promise<{ ok: boolean; message: string }> {
  // find the thread URL in the args (slack may auto-format URLs with angle brackets)
  const rawUrl = args.find((arg) => arg.includes("slack.com/"));
  if (!rawUrl) {
    return {
      ok: false,
      message:
        "usage: `/rooster triage <thread_url>`\n" +
        "copy the thread link from #customer-support and paste it as the argument.",
    };
  }

  // strip slack URL formatting: <url|label> or <url>
  const url = rawUrl.replace(/^</, "").replace(/(\|.*)?>/g, "");

  // parse the thread URL
  const parsed = parseThreadUrl(url);
  if (!parsed) {
    return {
      ok: false,
      message: "couldn't parse that thread URL. make sure it's a link to a thread in #customer-support.",
    };
  }

  const { channelId, threadTs } = parsed;

  // must be from #customer-support
  if (channelId !== CUSTOMER_SUPPORT_CHANNEL) {
    return {
      ok: false,
      message: "that thread isn't in <#" + CUSTOMER_SUPPORT_CHANNEL + ">. `/rooster triage` only works with #customer-support threads.",
    };
  }

  // fetch thread messages
  const messages = await fetchThreadMessages(app, channelId, threadTs);
  if (messages.length === 0) {
    return {
      ok: false,
      message: "couldn't fetch any messages from that thread. check that the link is correct.",
    };
  }

  // build prompt
  const prompt = await buildTriagePrompt(app, messages);

  // open Devin thread
  const result = await openDevinThread(app, prompt, url);

  if (!result.ok) {
    return {
      ok: false,
      message: `triage failed: ${result.error}`,
    };
  }

  return {
    ok: true,
    message: `triage started — Devin is analyzing the thread in <#${DEVIN_DOCS_RUNS_CHANNEL}>`,
  };
}
