/**
 * DiscordBot — discord.js bot wrapper.
 *
 * Handles:
 *   - Bot creation and WebSocket gateway connection
 *   - Inbound message parsing → ACP prompt() to Host
 *   - Message send/edit for streaming responses
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  type Attachment,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import type { Agent, ContentBlock } from "@vibearound/plugin-channel-sdk";
import type { AgentStreamHandler } from "./agent-stream.js";

type LogFn = (level: string, msg: string) => void;

export class DiscordBot {
  readonly client: Client;
  private agent: Agent;
  private log: LogFn;
  private cacheDir: string;
  private streamHandler: AgentStreamHandler | null = null;
  /** Cache of sent messages so we can edit them later. */
  private messageCache = new Map<string, Message>();

  constructor(botToken: string, agent: Agent, log: LogFn, cacheDir: string) {
    this.agent = agent;
    this.log = log;
    this.cacheDir = cacheDir;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // DM channels are not cached on startup, so without Partials.Channel
      // discord.js silently drops MessageCreate events that arrive for a
      // DM we haven't seen before. Partials.Message covers the rare case
      // where the inbound message itself is a partial.
      partials: [Partials.Channel, Partials.Message],
    });

    this.registerHandlers();
    this.client.login(botToken);
  }

  setStreamHandler(handler: AgentStreamHandler): void {
    this.streamHandler = handler;
  }

  /**
   * Start the bot. No-op for Discord — the constructor eagerly calls
   * `client.login()`, so the gateway connection is already in flight by
   * the time the SDK runner calls this. Exists purely to satisfy the
   * `ChannelBot` interface contract used by `runChannelPlugin`.
   */
  async start(): Promise<void> {
    // Intentionally empty.
  }

  /** Probe bot identity. */
  async probe(): Promise<{ id: string; username: string }> {
    // Wait for the client to be ready
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) {
        resolve();
      } else {
        this.client.once(Events.ClientReady, () => resolve());
      }
    });
    const user = this.client.user!;
    return { id: user.id, username: user.username };
  }

  /** Stop the bot. */
  stop(): void {
    this.client.destroy();
  }

  /** Send a message to a channel. Returns the message ID. */
  async sendMessage(channelId: string, content: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId) as TextBasedChannel | null;
    if (!channel || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }
    // Discord has a 2000 char limit — truncate if needed
    const truncated = content.length > 2000 ? content.slice(0, 1997) + "..." : content;
    const msg = await channel.send(truncated);
    this.messageCache.set(msg.id, msg);
    return msg.id;
  }

  /** Edit an existing message. */
  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const truncated = content.length > 2000 ? content.slice(0, 1997) + "..." : content;
    const cached = this.messageCache.get(messageId);
    if (cached) {
      await cached.edit(truncated);
      return;
    }
    // Fallback: fetch channel and message
    const channel = await this.client.channels.fetch(channelId) as TextBasedChannel | null;
    if (!channel || !("messages" in channel)) return;
    const msg = await channel.messages.fetch(messageId);
    await msg.edit(truncated);
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private registerHandlers(): void {
    this.client.once(Events.ClientReady, (c) => {
      this.log("info", `bot ready: ${c.user.username} (${c.user.id})`);
    });

    this.client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message);
    });

    this.client.on(Events.Error, (error) => {
      this.log("error", `client error: ${error.message}`);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot's own messages
    if (message.author.id === this.client.user?.id) return;
    // Ignore other bots
    if (message.author.bot) return;

    // In guild channels, only respond when @mentioned. DMs always pass through.
    const isDM = !message.guild;
    const isMentioned = message.mentions.has(this.client.user!);
    if (!isDM && !isMentioned) return;

    const channelId = message.channelId;
    // Strip the @mention from the text so the agent sees clean input
    let text = message.content;
    if (isMentioned && this.client.user) {
      text = text.replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "").trim();
    }

    if (!text && message.attachments.size === 0) return;

    this.log("debug", `message channel=${channelId} text=${(text ?? "").slice(0, 80)}`);

    // Build content blocks
    const contentBlocks: ContentBlock[] = [];

    if (text) {
      contentBlocks.push({ type: "text", text });
    }

    // Handle attachments (images, files).
    //
    // Discord CDN URLs (cdn.discordapp.com / media.discordapp.net) now ship
    // with signed, expiring query parameters. Claude Agent's fetch tool
    // can't reliably pull them — and for images we want them inlined as a
    // local file anyway so the ACPPod relocate step can drop them into the
    // workspace cache, matching how feishu handles media. Download here.
    for (const [, attachment] of message.attachments) {
      const localPath = await this.downloadAttachment(message.channelId, attachment).catch(
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log("warn", `failed to download attachment ${attachment.url}: ${msg}`);
          return null;
        },
      );
      if (!localPath) continue;

      if (!text) {
        contentBlocks.push({
          type: "text",
          text: `The user sent a file: ${attachment.name ?? "unknown"}`,
        });
      }
      contentBlocks.push({
        type: "resource_link",
        uri: `file://${localPath}`,
        name: attachment.name ?? "attachment",
        mimeType: attachment.contentType ?? "application/octet-stream",
      });
    }

    if (contentBlocks.length === 0) return;

    // Show typing indicator
    const channel = message.channel;
    if ("sendTyping" in channel) {
      await channel.sendTyping().catch(() => {});
    }
    const typingInterval = setInterval(() => {
      if ("sendTyping" in channel) {
        channel.sendTyping().catch(() => {});
      }
    }, 8000); // Discord typing expires after 10s

    // Notify stream handler before prompt
    this.streamHandler?.onPromptSent(channelId);

    try {
      const response = await this.agent.prompt({
        sessionId: channelId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done channel=${channelId} stopReason=${response.stopReason}`);
      await this.streamHandler?.onTurnEnd(channelId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log("error", `prompt failed channel=${channelId}: ${msg}`);
      await this.streamHandler?.onTurnError(channelId, msg);
    } finally {
      clearInterval(typingInterval);
    }
  }

  /**
   * Download a Discord attachment into the plugin cache directory and
   * return the local file path. Cached by attachment id so repeated
   * prompts referring to the same file don't re-download.
   */
  private async downloadAttachment(
    channelId: string,
    attachment: Attachment,
  ): Promise<string> {
    const ext = attachment.name && attachment.name.includes(".")
      ? `.${attachment.name.split(".").pop()}`
      : "";
    const dir = path.join(this.cacheDir, "discord", channelId);
    const localPath = path.join(dir, `${attachment.id}${ext}`);

    try {
      await fs.access(localPath);
      this.log("debug", `attachment cache hit: ${localPath}`);
      return localPath;
    } catch {
      // not cached, fall through to download
    }

    this.log(
      "debug",
      `downloading attachment id=${attachment.id} url=${attachment.url}`,
    );
    const res = await fetch(attachment.url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching attachment`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(localPath, buf);
    this.log(
      "debug",
      `cached attachment ${buf.length} bytes → ${localPath}`,
    );
    return localPath;
  }
}
