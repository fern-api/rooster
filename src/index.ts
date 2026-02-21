import { App } from "@slack/bolt";
import cron from "node-cron";
import { config } from "./config";
import { getCheckMessage, getCheckMineMessage, sendCheckMessage } from "./openThreadReminder";

const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  socketMode: true,
  appToken: config.slack.appToken,
});

// schedule the morning check for 9 AM on weekdays
cron.schedule("0 9 * * 1-5", async () => {
  console.log("running morning check (last 7 days, tagging on-call)...");
  try {
    await sendCheckMessage(app, true, { showNew: true, showOpen: true, days: 7 });
  } catch (error) {
    console.error("error sending morning check:", error);
  }
});

// schedule the end-of-day check for 5 PM on weekdays
cron.schedule("0 17 * * 1-5", async () => {
  console.log("running end-of-day check (tagging on-call)...");
  try {
    await sendCheckMessage(app, true, { showNew: true, showOpen: true, days: 1 });
  } catch (error) {
    console.error("error sending end-of-day check:", error);
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
      const filterMine = args.includes("--mine");

      // parse days argument (first numeric arg after "check")
      const daysArg = args.slice(1).find((arg) => /^\d+$/.test(arg));
      const days = daysArg ? Math.max(1, parseInt(daysArg, 10)) : 1;
      const timeframe = days === 1 ? "today" : `the last ${days} days`;

      // handle --mine flag: show issues assigned to the invoking user
      if (filterMine) {
        await respond(`checking your issues from ${timeframe}...`);
        try {
          const userInfo = await app.client.users.info({
            token: config.slack.botToken,
            user: command.user_id,
          });
          const userEmail = userInfo.user?.profile?.email;
          if (!userEmail) {
            await respond("❌ couldn't find your email in Slack. make sure your email is set in your Slack profile.");
            break;
          }

          const message = await getCheckMineMessage(app, days, userEmail);
          if (message) {
            await respond(message);
          } else {
            await respond("✅ no issues assigned to you!");
          }
        } catch (error) {
          console.error("error during check --mine:", error);
          await respond("❌ error running the check. see logs for details.");
        }
        break;
      }

      // if neither --new nor --open specified, show both
      const showNew = filterNew || (!filterNew && !filterOpen);
      const showOpen = filterOpen || (!filterNew && !filterOpen);

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
          "  - add `--remind` to tag on-call\n" +
          "  - add `--mine` to show only issues assigned to you (new or waiting-on-you)"
      );
  }
});

(async () => {
  await app.start();
  console.log("rooster is running!");
  console.log("scheduled: morning check at 9 AM on weekdays");
  console.log("scheduled: end-of-day check at 5 PM on weekdays");
})();
