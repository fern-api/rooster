import crypto from "crypto";
import { Request, Response } from "express";
import { App } from "@slack/bolt";
import { config } from "./config";
import { getOncallMentions } from "./openThreadReminder";

const TRIAGE_PROMPT = `Please triage this customer support issue.

1. Determine which on-call team should handle this and tag them in your response (exact Slack handles provided below).
2. Based on the issue, decide on next steps:
  a. If this can be resolved with a support response, draft a message for the on-call to send to the customer.
  b. If this requires a code change, identify the relevant repo and draft a PR to fix the issue.
   
For usage or custom configuration issues, or if you're not sure who to tag, tag @sales-eng-on-call. For product issues, tag the on-call engineer for that product. AI and Dashboard counts as Docs.
   
Bias towards suggesting an existing configuration or recommending a custom solution they can implement themselves before escalating to product changes.`;

/**
 * builds a slack thread URL from channel ID and message timestamp
 */
function buildThreadUrl(channelId: string, ts: string): string {
  const tsForUrl = ts.replace(".", "");
  return `https://buildwithfern.slack.com/archives/${channelId}/p${tsForUrl}`;
}

/**
 * verifies the Pylon webhook signature using HMAC-SHA256
 */
function verifySignature(payload: string, signature: string, timestamp: string): boolean {
  const signingContent = `${timestamp}.${payload}`;
  const expectedSig = crypto
    .createHmac("sha256", config.webhook.pylonSecret)
    .update(signingContent)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
}

/**
 * attempts to extract issue data from the webhook payload
 * tries common shapes: data, issue, or top-level fields
 */
function extractIssueData(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.data && typeof payload.data === "object") {
    return payload.data as Record<string, unknown>;
  }
  if (payload.issue && typeof payload.issue === "object") {
    return payload.issue as Record<string, unknown>;
  }
  // assume top-level fields are the issue data
  return payload;
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

  // attachment urls
  const attachments = issue.attachment_urls as string[] | undefined;
  if (attachments?.length) parts.push(`Attachments:\n${attachments.join("\n")}`);

  return parts.length > 0 ? `\n\nIssue context:\n${parts.join("\n")}` : "";
}

/**
 * creates the Express request handler for the Pylon webhook endpoint
 */
export function createWebhookHandler(app: App): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers["pylon-webhook-signature"] as string | undefined;
    const timestamp = req.headers["pylon-webhook-timestamp"] as string | undefined;
    const rawBody = (req as Request & { rawBody?: string }).rawBody;

    if (!signature || !timestamp || !rawBody) {
      console.log("[triage] webhook rejected: missing signature, timestamp, or body");
      res.status(401).json({ error: "missing signature headers" });
      return;
    }

    try {
      if (!verifySignature(rawBody, signature, timestamp)) {
        console.log("[triage] webhook rejected: invalid signature");
        res.status(401).json({ error: "invalid signature" });
        return;
      }
    } catch {
      console.log("[triage] webhook rejected: signature verification failed");
      res.status(401).json({ error: "invalid signature" });
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
