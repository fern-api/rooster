import { App } from "@slack/bolt";
import { config } from "./config";

const CUSTOMER_SUPPORT_CHANNEL = "C052DFWVCG6";

const TRIAGE_PROMPT = `Please triage this customer support thread.

1. Determine which on-call team should handle this: @sdk-on-call, @docs-on-call, or @sales-eng-on-call. Tag them in your response.
2. Based on the issue, decide on next steps:
   a. If this can be resolved with a support response, draft a message for the on-call to send to the customer.
   b. If this requires a code change, identify the relevant repo and draft a PR to fix the issue.`;

/**
 * builds a slack thread URL from channel ID and message timestamp
 */
function buildThreadUrl(channelId: string, ts: string): string {
  const tsForUrl = ts.replace(".", "");
  return `https://buildwithfern.slack.com/archives/${channelId}/p${tsForUrl}`;
}

/**
 * registers the triage app_mention listener
 * triggered by mentioning @rooster with "triage" in a #customer-support thread
 *
 * posts a new message in #devin-triage-runs that @mentions Devin with the
 * triage prompt and a link to the source thread. replies in the original
 * thread with a link to the triage run.
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

    const sourceThreadUrl = buildThreadUrl(channelId, threadTs);

    // post triage request in #devin-triage-runs
    try {
      const triageMsg = await app.client.chat.postMessage({
        token: config.slack.botToken,
        channel: config.devin.triageChannel,
        text: `<@${config.devin.slackUserId}> ${TRIAGE_PROMPT}\n\nSource thread: ${sourceThreadUrl}`,
        unfurl_links: false,
      });

      // link back from the original thread to the triage run
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
    } catch (error) {
      console.error("error starting triage:", error);
      await app.client.chat.postMessage({
        token: config.slack.botToken,
        channel: channelId,
        thread_ts: threadTs,
        text: "failed to start triage. check logs for details.",
        unfurl_links: false,
      });
    }
  });
}
