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
  ActionRowBuilder,
  type Attachment,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
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
  async sendMessage(chatId: string, content: string): Promise<string> {
    const channel = await this.client.channels.fetch(chatId) as TextBasedChannel | null;
    if (!channel || !("send" in channel)) {
      throw new Error(`Channel ${chatId} not found or not text-based`);
    }
    // Discord has a 2000 char limit — truncate if needed
    const truncated = content.length > 2000 ? content.slice(0, 1997) + "..." : content;
    const msg = await channel.send(truncated);
    this.messageCache.set(msg.id, msg);
    return msg.id;
  }

  /** Send a message with a row of buttons. Used by permission UI. */
  async sendButtons(
    chatId: string,
    content: string,
    buttons: { customId: string; label: string; style: "primary" | "danger" | "secondary" }[],
  ): Promise<string> {
    const channel = await this.client.channels.fetch(chatId) as TextBasedChannel | null;
    if (!channel || !("send" in channel)) {
      throw new Error(`Channel ${chatId} not found or not text-based`);
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      buttons.map((b) =>
        new ButtonBuilder()
          .setCustomId(b.customId.slice(0, 100))
          .setLabel(b.label.slice(0, 80))
          .setStyle(buttonStyleToEnum(b.style)),
      ),
    );
    const msg = await channel.send({ content, components: [row] });
    return msg.id;
  }

  /** Edit an existing message. */
  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    const truncated = content.length > 2000 ? content.slice(0, 1997) + "..." : content;
    const cached = this.messageCache.get(messageId);
    if (cached) {
      await cached.edit(truncated);
      return;
    }
    // Fallback: fetch channel and message
    const channel = await this.client.channels.fetch(chatId) as TextBasedChannel | null;
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

    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction);
    });

    this.client.on(Events.Error, (error) => {
      this.log("error", `client error: ${error.message}`);
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;
    const btn = interaction as ButtonInteraction;
    const id = btn.customId;
    if (!id.startsWith("va_perm:")) return;

    const rest = id.slice("va_perm:".length);
    const colon = rest.indexOf(":");
    if (colon <= 0) return;
    const callbackId = rest.slice(0, colon);
    const optionId = rest.slice(colon + 1);

    const ok =
      this.streamHandler?.resolvePermission(callbackId, optionId) ?? false;
    this.log(
      "info",
      `permission resolve cb=${callbackId} option=${optionId} ok=${ok}`,
    );
    // Recover the human label from the pressed button. Discord.js types include
    // SKU buttons which have no label — narrow with a defensive access.
    const optionName =
      (btn.component as { label?: string | null } | undefined)?.label ?? optionId;
    try {
      await btn.update({
        content: ok
          ? `🔐 Permission — selected: **${optionName}**`
          : `🔐 Permission — already handled`,
        components: [],
      });
    } catch (e) {
      this.log("error", `permission ack failed: ${e}`);
    }
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

    const chatId = message.channelId;
    // Strip the @mention from the text so the agent sees clean input
    let text = message.content;
    if (isMentioned && this.client.user) {
      text = text.replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "").trim();
    }

    if (!text && message.attachments.size === 0) return;

    this.log("debug", `message channel=${chatId} text=${(text ?? "").slice(0, 80)}`);

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

    // If a permission prompt is awaiting text, consume this message.
    if (text && this.streamHandler?.consumePendingText(chatId, text)) {
      return;
    }

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
    this.streamHandler?.onPromptSent(chatId);

    try {
      const response = await this.agent.prompt({
        sessionId: chatId,
        prompt: contentBlocks,
      });
      this.log("info", `prompt done channel=${chatId} stopReason=${response.stopReason}`);
      await this.streamHandler?.onTurnEnd(chatId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log("error", `prompt failed channel=${chatId}: ${msg}`);
      await this.streamHandler?.onTurnError(chatId, msg);
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
    chatId: string,
    attachment: Attachment,
  ): Promise<string> {
    const ext = attachment.name && attachment.name.includes(".")
      ? `.${attachment.name.split(".").pop()}`
      : "";
    const dir = path.join(this.cacheDir, "discord", chatId);
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

function buttonStyleToEnum(s: "primary" | "danger" | "secondary"): ButtonStyle {
  switch (s) {
    case "primary": return ButtonStyle.Primary;
    case "danger":  return ButtonStyle.Danger;
    default:        return ButtonStyle.Secondary;
  }
}
