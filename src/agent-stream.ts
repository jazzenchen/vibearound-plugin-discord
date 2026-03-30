/**
 * AgentStreamHandler — receives ACP session updates from the Host and renders
 * them as separate Discord messages, one per contiguous variant block.
 *
 * Extends BlockRenderer from @vibearound/plugin-channel-sdk which handles:
 *   - Block accumulation and kind-change detection
 *   - Debounced flushing + edit throttling (1000ms for Discord's rate limit)
 *   - Serialized sendChain for guaranteed message order
 *   - Verbose filtering (thinking / tool blocks)
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { DiscordBot } from "./bot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogFn = (level: string, msg: string) => void;

// ---------------------------------------------------------------------------
// AgentStreamHandler
// ---------------------------------------------------------------------------

export class AgentStreamHandler extends BlockRenderer<string> {
  private discordBot: DiscordBot;
  private log: LogFn;
  private lastActiveChannelId: string | null = null;

  constructor(discordBot: DiscordBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      flushIntervalMs: 500,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.discordBot = discordBot;
    this.log = log;
  }

  // ---- BlockRenderer overrides ----

  /** Discord uses plain text with emoji prefixes. */
  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `💭 ${content}`;
      case "tool":     return content.trim();
      case "text":     return content;
    }
  }

  /** Send new message to Discord channel. */
  protected async sendBlock(channelId: string, _kind: BlockKind, content: string): Promise<string | null> {
    try {
      const messageId = await this.discordBot.sendMessage(channelId, content);
      return messageId;
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
      return null;
    }
  }

  /** Edit existing message for streaming updates. */
  protected async editBlock(
    channelId: string,
    ref: string,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    try {
      await this.discordBot.editMessage(channelId, ref, content);
    } catch (e) {
      this.log("error", `editBlock failed: ${e}`);
    }
  }

  /** Cleanup after turn completes. */
  protected async onAfterTurnEnd(channelId: string): Promise<void> {
    this.log("debug", `turn_complete channel=${channelId}`);
  }

  /** Send error message to user. */
  protected async onAfterTurnError(channelId: string, error: string): Promise<void> {
    this.discordBot.sendMessage(channelId, `❌ Error: ${error}`).catch(() => {});
  }

  // ---- Prompt lifecycle ----

  onPromptSent(channelId: string): void {
    this.lastActiveChannelId = channelId;
    super.onPromptSent(channelId);
  }

  // ---- Host ext notification handlers ----

  onAgentReady(agent: string, version: string): void {
    const channelId = this.lastActiveChannelId;
    if (channelId) {
      this.discordBot.sendMessage(channelId, `🤖 Agent: ${agent} v${version}`).catch(() => {});
    }
  }

  onSessionReady(sessionId: string): void {
    const channelId = this.lastActiveChannelId;
    if (channelId) {
      this.discordBot.sendMessage(channelId, `📋 Session: ${sessionId}`).catch(() => {});
    }
  }

  onSystemText(text: string): void {
    const channelId = this.lastActiveChannelId;
    if (channelId) {
      this.discordBot.sendMessage(channelId, text).catch(() => {});
    }
  }
}
