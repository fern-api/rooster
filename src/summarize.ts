import { App } from "@slack/bolt";
import OpenAI from "openai";
import { config } from "./config";
import { fetchThreadMessages, SlackMessage } from "./slackUtils";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

const SUMMARIZE_SYSTEM_PROMPT = `You are a helpful assistant that summarizes Slack threads. Given a series of messages from a Slack thread, produce a concise summary that:

1. Starts with a brief overview of what the thread is about (1-2 sentences).
2. Highlights any **decisions** that were made (prefix each with "Decision:").
3. Highlights any **action items** that were identified, including who is responsible if mentioned (prefix each with "Action item:").

Format using Slack mrkdwn (use *bold* for emphasis, bullet points with •). Keep it concise but don't miss important details. If there are no decisions or action items, omit those sections.`;

/**
 * returns true if a message looks like the "@rooster summarize" command itself
 */
function isSummarizeCommand(msg: SlackMessage): boolean {
  if (!msg.text) return false;
  if (!/summarize/i.test(msg.text) || !msg.text.includes("<@")) return false;
  const stripped = msg.text.replace(/<@[A-Z0-9]+>/g, "").trim().toLowerCase();
  return stripped === "summarize";
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
    const threadContent = await fetchThreadMessages(app, channel, threadTs, {
      skipMessage: isSummarizeCommand,
    });

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
