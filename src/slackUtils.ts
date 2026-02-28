import { App } from "@slack/bolt";
import { config } from "./config";

// Cache for user display names
const userNameCache = new Map<string, string>();

export interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
}

/**
 * resolves a Slack user ID to a display name, with caching
 */
export async function resolveUserName(app: App, userId: string): Promise<string> {
  if (userNameCache.has(userId)) {
    return userNameCache.get(userId)!;
  }

  try {
    const result = await app.client.users.info({
      token: config.slack.botToken,
      user: userId,
    });
    const name = result.user?.real_name || result.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/**
 * replaces <@U...> mentions in message text with real display names
 */
export async function resolveUserMentions(app: App, text: string): Promise<string> {
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

export interface FetchThreadOptions {
  /** messages matching this filter will be excluded from the result */
  skipMessage?: (msg: SlackMessage) => boolean;
}

/**
 * fetches all messages in a thread and formats them as "Author: text" blocks.
 * resolves user IDs to display names and expands inline @mentions.
 */
export async function fetchThreadMessages(
  app: App,
  channel: string,
  threadTs: string,
  options?: FetchThreadOptions,
): Promise<string> {
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
    if (options?.skipMessage?.(msg)) continue;

    const author = msg.user ? (nameMap.get(msg.user) || msg.user) : "bot";
    const text = msg.text ? await resolveUserMentions(app, msg.text) : "(no text)";
    formatted.push(`${author}: ${text}`);
  }

  return formatted.join("\n\n");
}
