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

- `/rooster-status` - check if rooster is running
- `/rooster-check` - manually trigger the open thread reminder

## more functions coming soon...