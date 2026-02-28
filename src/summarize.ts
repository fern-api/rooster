import { App } from "@slack/bolt";
import OpenAI from "openai";
import { config } from "./config";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

const SUMMARIZE_SYSTEM_PROMPT = `You are a helpful assistant that summarizes Slack threads. Given a series of messages from a Slack thread, produce a concise summary that:

1. Starts with a brief overview of what the thread is about (1-2 sentences).
2. Highlights any **decisions** that were made (prefix each with "Decision:").
3. Highlights any **action items** that were identified, including who is responsible if mentioned (prefix each with "Action item:").

Format using Slack mrkdwn (use *bold* for emphasis, bullet points with •). Keep it concise but don't miss important details. If there are no decisions or action items, omit those sections.`;

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
}

/**
 * resolves a Slack user ID to a display name
 */
async function resolveUserName(app: App, userId: string): Promise<string> {
  try {
    const result = await app.client.users.info({
      token: config.slack.botToken,
      user: userId,
    });
    return result.user?.real_name || result.user?.name || userId;
  } catch {
    return userId;
  }
}

/**
 * replaces <@U...> mentions in message text with real names
 */
async function resolveUserMentions(app: App, text: string): Promise<string> {
  const mentionRegex = /<@(U[A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionRegex)];

  if (matches.length === 0) return text;

  const userIds = [...new Set(matches.map((m) => m[1]))];
  const nameMap = new Map<string, string>();

  await Promise.all(
    userIds.map(async (id) => {
      const name = await resolveUserName(app, id);
      nameMap.set(id, name);
    })
  );

  return text.replace(mentionRegex, (_match, userId) => {
    return nameMap.get(userId) || userId;
  });
}

/**
 * fetches all messages in a thread and formats them for summarization
 */
async function fetchThreadMessages(app: App, channel: string, threadTs: string): Promise<string> {
  const result = await app.client.conversations.replies({
    token: config.slack.botToken,
    channel,
    ts: threadTs,
    limit: 200,
  });

  const messages = (result.messages ?? []) as SlackMessage[];

  // resolve all user names in parallel
  const userIds = [...new Set(messages.map((m) => m.user).filter(Boolean) as string[])];
  const nameMap = new Map<string, string>();
  await Promise.all(
    userIds.map(async (id) => {
      const name = await resolveUserName(app, id);
      nameMap.set(id, name);
    })
  );

  const formatted: string[] = [];
  for (const msg of messages) {
    // skip the @rooster summarize message itself
    if (msg.text && /summarize/i.test(msg.text) && msg.text.includes(`<@`)) {
      const isSummarizeCommand = msg.text.replace(/<@[A-Z0-9]+>/g, "").trim().toLowerCase() === "summarize";
      if (isSummarizeCommand) continue;
    }

    const author = msg.user ? (nameMap.get(msg.user) || msg.user) : "bot";
    const text = msg.text ? await resolveUserMentions(app, msg.text) : "(no text)";
    formatted.push(`${author}: ${text}`);
  }

  return formatted.join("\n\n");
}

/**
 * generates a summary of the thread using OpenAI
 */
async function generateSummary(threadContent: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here is the Slack thread to summarize:\n\n${threadContent}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  });

  return response.choices[0]?.message?.content || "Could not generate summary.";
}

/**
 * handles the @rooster summarize command in a thread
 */
export async function handleSummarize(app: App, channel: string, threadTs: string, messageTs: string): Promise<void> {
  console.log(`[summarize] summarizing thread in channel=${channel} thread_ts=${threadTs}`);

  // post a "working on it" reaction
  try {
    await app.client.reactions.add({
      token: config.slack.botToken,
      channel,
      timestamp: messageTs,
      name: "hourglass_flowing_sand",
    });
  } catch {
    // reaction may fail if already added, ignore
  }

  try {
    const threadContent = await fetchThreadMessages(app, channel, threadTs);

    if (threadContent.trim().length === 0) {
      await app.client.chat.postMessage({
        token: config.slack.botToken,
        channel,
        thread_ts: threadTs,
        text: "There are no messages in this thread to summarize.",
      });
      return;
    }

    console.log(`[summarize] fetched thread content (${threadContent.length} chars), generating summary...`);
    const summary = await generateSummary(threadContent);
    console.log(`[summarize] generated summary (${summary.length} chars)`);

    await app.client.chat.postMessage({
      token: config.slack.botToken,
      channel,
      thread_ts: threadTs,
      text: `*Thread Summary*\n\n${summary}`,
      unfurl_links: false,
    });

    // replace hourglass with checkmark
    try {
      await app.client.reactions.remove({
        token: config.slack.botToken,
        channel,
        timestamp: messageTs,
        name: "hourglass_flowing_sand",
      });
      await app.client.reactions.add({
        token: config.slack.botToken,
        channel,
        timestamp: messageTs,
        name: "white_check_mark",
      });
    } catch {
      // reaction cleanup is best-effort
    }

    console.log(`[summarize] posted summary to thread`);
  } catch (error) {
    console.error("[summarize] error generating summary:", error);

    // replace hourglass with error reaction
    try {
      await app.client.reactions.remove({
        token: config.slack.botToken,
        channel,
        timestamp: messageTs,
        name: "hourglass_flowing_sand",
      });
      await app.client.reactions.add({
        token: config.slack.botToken,
        channel,
        timestamp: messageTs,
        name: "x",
      });
    } catch {
      // reaction cleanup is best-effort
    }

    await app.client.chat.postMessage({
      token: config.slack.botToken,
      channel,
      thread_ts: threadTs,
      text: "Sorry, I encountered an error while summarizing this thread.",
      unfurl_links: false,
    });
  }
}
