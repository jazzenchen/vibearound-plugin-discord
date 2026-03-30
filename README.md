# VibeAround Discord Plugin

A [VibeAround](https://github.com/anthropics/vibearound) channel plugin that bridges Discord to AI coding agents (Claude, Gemini, Codex, etc.) via the [Agent Client Protocol](https://github.com/anthropics/agent-client-protocol).

Talk to your agent by @mentioning the bot in any channel, or DM it directly.

## Features

- **@mention to talk** — bot only responds when mentioned in server channels; DMs always work
- **Streaming responses** — agent output streams in real-time via message editing
- **File attachments** — send images, documents, and other files to the agent
- **Typing indicator** — shows the bot is thinking while the agent processes
- **Multi-channel** — each Discord channel gets its own independent agent session

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name (e.g. "VibeAround")
3. Go to the **Bot** tab

### 2. Enable Privileged Intents

In the **Bot** tab, scroll to **Privileged Gateway Intents** and enable:

- **Message Content Intent** (required — lets the bot read message text)
- **Server Members Intent** (recommended)

Click **Save Changes**.

### 3. Copy the Bot Token

In the **Bot** tab, click **Reset Token** and copy it. Keep this secret.

### 4. Invite the Bot to Your Server

Go to **OAuth2** → **URL Generator**:

- **Scopes**: check `bot` and `applications.commands`
- **Bot Permissions**: check:
  - View Channels
  - Send Messages
  - Read Message History
  - Embed Links
  - Attach Files
  - Add Reactions

Copy the generated URL and open it in your browser to add the bot to your server.

### 5. Configure VibeAround

Add the bot token to `~/.vibearound/settings.json`:

```json
{
  "channels": {
    "discord": {
      "bot_token": "YOUR_BOT_TOKEN_HERE",
      "verbose": {
        "show_thinking": false,
        "show_tool_use": false
      }
    }
  }
}
```

### 6. Start VibeAround

The Discord plugin starts automatically when VibeAround launches. The bot will appear online in your server.

## Usage

- **In a server channel**: `@VibeAround help me write a function that sorts by date`
- **In a DM**: just send a message directly, no @mention needed
- **With attachments**: attach a file and add a message like "review this code"

## Verbose Options

| Option | Default | Description |
|---|---|---|
| `show_thinking` | `false` | Show the agent's internal reasoning as separate messages |
| `show_tool_use` | `false` | Show tool calls (file reads, edits, etc.) as they happen |

## Limitations

- Discord has a 2000-character message limit. Long responses are truncated.
- The bot uses one agent session per Discord channel. Switch channels for a fresh session.

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Type check (watch mode)
bun run dev
```

Built with [@vibearound/plugin-channel-sdk](https://www.npmjs.com/package/@vibearound/plugin-channel-sdk) and [discord.js](https://discord.js.org/).

## License

MIT
