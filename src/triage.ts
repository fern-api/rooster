import { Request, Response } from "express";
import { App } from "@slack/bolt";
import { config } from "./config";
import { getOncallMentions } from "./openThreadReminder";

const TRIAGE_PROMPT = `Triage this customer support issue. Use the exact Slack handles listed below.

## Routing
- Usage, configuration, or unclear issues → tag @sales-eng-on-call
- Product bugs or feature gaps → tag the product on-call (AI and Dashboard = Docs team)

## Response
1. Tag the appropriate on-call team.
2. Summarize the issue in 1-2 sentences.
3. Recommend ONE of these actions:
   a. **Support response** — if resolvable via existing config or docs, draft a reply for the on-call to send the customer. Prefer this over escalating to product changes.
   b. **Code change needed** — if it's a bug or missing functionality, identify the relevant repo and describe the fix needed.
4. If the issue is time-sensitive or blocking the customer, flag it as urgent.`;

/**
 * builds a slack thread URL from channel ID and message timestamp
 */
function buildThreadUrl(channelId: string, ts: string): string {
  const tsForUrl = ts.replace(".", "");
  return `https://buildwithfern.slack.com/archives/${channelId}/p${tsForUrl}`;
}

/**
 * attempts to extract issue data from the webhook payload
 * tries common shapes: data, issue, or top-level fields
 */
/**
 * returns true if a value is an unresolved template placeholder like "{{issue.title}}"
 */
function isTemplatePlaceholder(value: unknown): boolean {
  return typeof value === "string" && /\{\{.*\}\}/.test(value);
}

/**
 * recursively strips keys whose values are unresolved template placeholders
 */
function stripPlaceholders(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isTemplatePlaceholder(value)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = stripPlaceholders(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) cleaned[key] = nested;
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function extractIssueData(payload: Record<string, unknown>): Record<string, unknown> {
  let issue: Record<string, unknown>;
  if (payload.data && typeof payload.data === "object") {
    issue = payload.data as Record<string, unknown>;
  } else if (payload.issue && typeof payload.issue === "object") {
    issue = payload.issue as Record<string, unknown>;
  } else {
    // assume top-level fields are the issue data
    issue = payload;
  }
  return stripPlaceholders(issue);
}

/**
 * builds triage context string from whatever fields are available in the issue data
 */
function buildTriageContext(issue: Record<string, unknown>): string {
  const parts: string[] = [];

  if (issue.title) parts.push(`Title: ${issue.title}`);
  if (issue.body_html) parts.push(`Issue body:\n${issue.body_html}`);

  // account info — could be nested object or string
  const account = issue.account as Record<string, unknown> | undefined;
  if (account?.name) parts.push(`Account: ${account.name}`);

  // requester info
  const requester = issue.requester as Record<string, unknown> | undefined;
  if (requester?.email) parts.push(`Requester: ${requester.email}`);

  if (issue.state) parts.push(`State: ${issue.state}`);
  if (issue.link) parts.push(`Pylon link: ${issue.link}`);

  // slack thread link so triagers can jump to the original conversation
  const slack = issue.slack as Record<string, unknown> | undefined;
  if (slack) {
    const channelId = slack.channel_id as string | undefined;
    const ts = (slack.thread_ts as string) || (slack.message_ts as string);
    if (channelId && ts) {
      parts.push(`Slack thread: ${buildThreadUrl(channelId, ts)}`);
    }
  }

  // attachment urls — may arrive as a string instead of an array
  const raw = issue.attachment_urls;
  const attachments = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  if (attachments.length) parts.push(`Attachments:\n${attachments.join("\n")}`);

  return parts.length > 0 ? `\n\nIssue context:\n${parts.join("\n")}` : "";
}

/**
 * creates the Express request handler for the Pylon webhook endpoint
 */
export function createWebhookHandler(app: App): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    console.log("[triage] incoming webhook headers:", JSON.stringify(req.headers, null, 2));
    console.log("[triage] incoming webhook body:", JSON.stringify(req.body, null, 2));

    const secret = req.headers["x-webhook-secret"] as string | undefined;

    if (!secret || secret !== config.webhook.pylonSecret) {
      console.log("[triage] webhook rejected: missing or invalid secret");
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // log the full payload for debugging (we don't know the exact shape yet)
    console.log("[triage] webhook payload:", JSON.stringify(req.body, null, 2));

    // acknowledge the webhook immediately
    res.status(200).json({ ok: true });

    // process asynchronously
    try {
      const payload = req.body as Record<string, unknown>;
      console.log("[triage] extracting issue data from payload, top-level keys:", Object.keys(payload));
      const issue = extractIssueData(payload);
      console.log("[triage] extracted issue fields:", Object.keys(issue));
      const triageContext = buildTriageContext(issue);
      console.log(`[triage] built triage context (${triageContext.length} chars)`);

      // resolve on-call mentions so Devin knows the exact Slack handles
      console.log("[triage] resolving on-call mentions");
      const oncallMentions = await getOncallMentions(app);
      console.log(`[triage] on-call mentions: ${oncallMentions.trim()}`);

      const triageMessage =
        `<@${config.devin.slackUserId}> ${TRIAGE_PROMPT}\n\n` +
        `On-call handles to use: ${oncallMentions}` +
        triageContext;

      // post triage request in #devin-triage-runs
      console.log(`[triage] posting triage message to channel=${config.devin.triageChannel} (${triageMessage.length} chars)`);
      const triageMsg = await app.client.chat.postMessage({
        token: config.slack.botToken,
        channel: config.devin.triageChannel,
        text: triageMessage,
        unfurl_links: false,
      });

      console.log(`[triage] posted to devin triage channel, ts=${triageMsg.ts}`);

      // try to post a notification in the original Slack thread if we have channel/thread info
      const slack = (issue.slack as Record<string, unknown>) ?? {};
      const channelId = slack.channel_id as string | undefined;
      const threadTs = (slack.thread_ts as string) || (slack.message_ts as string);

      if (channelId && threadTs) {
        console.log(`[triage] posting notification in original thread: channel=${channelId} thread_ts=${threadTs}`);
        const triageThreadUrl = triageMsg.ts
          ? buildThreadUrl(config.devin.triageChannel, triageMsg.ts)
          : null;

        await app.client.chat.postMessage({
          token: config.slack.botToken,
          channel: channelId,
          thread_ts: threadTs,
          text: triageThreadUrl
            ? `triaging this thread in <#${config.devin.triageChannel}>: ${triageThreadUrl}`
            : `triaging this thread in <#${config.devin.triageChannel}>`,
          unfurl_links: false,
        });

        console.log("[triage] posted notification in original thread");
      } else {
        console.log(`[triage] no slack thread info found on issue, skipping thread notification (channel_id=${channelId}, thread_ts=${threadTs})`);
      }
    } catch (error) {
      console.error("[triage] error processing webhook:", error);
    }
  };
}
