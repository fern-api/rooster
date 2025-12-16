import { App } from "@slack/bolt";
import cron from "node-cron";
import { config } from "./config";
import {
  getUnrespondedThreadsMessage,
  sendOpenThreadReminder,
  sendUnrespondedThreadsReminder,
} from "./openThreadReminder";

const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  socketMode: true,
  appToken: config.slack.appToken,
});

// schedule the open thread reminder for 5 PM on weekdays
cron.schedule("0 17 * * 1-5", async () => {
  console.log("running end-of-day open thread check...");
  try {
    await sendOpenThreadReminder(app);
  } catch (error) {
    console.error("error sending open thread reminder:", error);
  }
});

// single rooster command with subcommands
app.command("/rooster", async ({ ack, respond, command }) => {
  await ack();
  const args = command.text?.trim().split(/\s+/) || [];
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "status":
      await respond("rooster is alive and watching for open threads!");
      break;

    case "check": {
      const tagOncall = args.includes("--remind");
      const sendToChannel = tagOncall || args.includes("--channel");

      // parse days argument (first numeric arg after "check")
      const daysArg = args.slice(1).find((arg) => /^\d+$/.test(arg));
      const days = daysArg ? Math.max(1, parseInt(daysArg, 10)) : 1;
      const timeframe = days === 1 ? "today" : `the last ${days} days`;

      await respond(`checking unresponded threads from ${timeframe}...`);
      try {
        if (sendToChannel) {
          const sent = await sendUnrespondedThreadsReminder(app, tagOncall, days);
          if (!sent) {
            await respond("✅ no unresponded threads found!");
          }
        } else {
          const message = await getUnrespondedThreadsMessage(app, days);
          if (message) {
            await respond(message);
          } else {
            await respond("✅ no unresponded threads found!");
          }
        }
      } catch (error) {
        console.error("error during manual check:", error);
        await respond("❌ error running the check. see logs for details.");
      }
      break;
    }

    default:
      await respond(
        "available commands:\n" +
          "• `/rooster status` - check if rooster is running\n" +
          "• `/rooster check [days]` - check for unresponded threads (default: 1 day)\n" +
          "  - add a number for more days, e.g. `/rooster check 3`\n" +
          "  - add `--channel` to post to channel\n" +
          "  - add `--remind` to tag on-call"
      );
  }
});

(async () => {
  await app.start();
  console.log("rooster is running!");
  console.log("scheduled: open thread reminder at 5 PM on weekdays");
})();
