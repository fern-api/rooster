import { App } from "@slack/bolt";
import cron from "node-cron";
import { config } from "./config";
import {
  getCheckMessage,
  sendCheckMessage,
  sendOpenThreadReminder,
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
      const filterNew = args.includes("--new");
      const filterOpen = args.includes("--open");

      // if neither --new nor --open specified, show both
      const showNew = filterNew || (!filterNew && !filterOpen);
      const showOpen = filterOpen || (!filterNew && !filterOpen);

      // parse days argument (first numeric arg after "check")
      const daysArg = args.slice(1).find((arg) => /^\d+$/.test(arg));
      const days = daysArg ? Math.max(1, parseInt(daysArg, 10)) : 1;
      const timeframe = days === 1 ? "today" : `the last ${days} days`;

      await respond(`checking issues from ${timeframe}...`);
      try {
        const options = { showNew, showOpen, days };
        if (sendToChannel) {
          const sent = await sendCheckMessage(app, tagOncall, options);
          if (!sent) {
            await respond("✅ no issues found!");
          }
        } else {
          const message = await getCheckMessage(app, options);
          if (message) {
            await respond(message);
          } else {
            await respond("✅ no issues found!");
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
          "• `/rooster check [days]` - check for issues (default: 1 day)\n" +
          "  - add a number for more days, e.g. `/rooster check 3`\n" +
          "  - add `--new` to show only new (unassigned) issues\n" +
          "  - add `--open` to show only waiting-on-you issues\n" +
          "  - by default, shows both new and open issues in separate sections\n" +
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
