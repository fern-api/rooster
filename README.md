# rooster

rooster is a maintenance slack app that performs various duties in the fern slack environment.

## open customer threads
if a support thread in `#customer-alerts` has not been marked with ✅ by the end of the day, it will be included in a round-up of messages, all sent to the `#customer-alerts` channel, tagging the deployed engineer on-call.

## setup

### 1. create a slack app

1. go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. enable **socket mode** under settings → socket mode
3. add the following **bot token scopes** under oauth & permissions:
   - `channels:read` - to find the #customer-alerts channel
   - `channels:history` - to read messages in the channel
   - `reactions:read` - to check for ✅ reactions
   - `chat:write` - to post reminder messages
   - `commands` - for slash commands
4. create **slash commands** under features → slash commands:
   - `/rooster-status` - health check
   - `/rooster-check` - manually trigger the open thread check
5. generate an **app-level token** under settings → basic information → app-level tokens with the `connections:write` scope
6. install the app to your workspace

### 2. configure incident.io

1. generate an api key from your incident.io dashboard (settings → api keys)
2. find your on-call schedule id in incident.io under schedules
3. ensure team members have their slack user ids configured in incident.io for tagging to work

### 3. environment variables

copy `.env.example` to `.env` and fill in the values:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
INCIDENT_IO_API_KEY=your-incident-io-api-key
INCIDENT_IO_SCHEDULE_ID=your-schedule-id
```

### 4. run the app

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