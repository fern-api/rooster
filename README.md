# rooster

rooster is a maintenance slack app that performs various duties in the fern slack environment.

## open customer threads
if a support thread in `#customer-alerts` has not been marked with ✅ by the end of the day, it will be included in a round-up of messages, all sent to the `#customer-alerts` channel, tagging the deployed engineer on-call.

## setup

### run the app

```bash
pnpm install
pnpm run build
pnpm start
```

for development:
```bash
pnpm run dev
```

## slack commands

- `/rooster status` - check if rooster is running
- `/rooster check [days]` - check for issues (default: 1 day)
  - by default, shows both new (unassigned) and waiting-on-you issues in separate sections
  - e.g. `/rooster check 3` checks the last 3 days
  - add `--new` to show only new (unassigned) issues
  - add `--open` to show only waiting-on-you issues
  - add `--channel` to post results to #customer-alerts
  - add `--remind` to tag on-call engineers (implies --channel)

## more functions coming soon...
- alert for stale PRs
- alert for tagged, open issues
- alert immediately for high-risk messages (e.g. "broken", "down", "inaccessible")
