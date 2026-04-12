/**
 * Discord stream renderer — extends BlockRenderer with Discord-specific transport.
 *
 * Only implements sendText/sendBlock/editBlock + formatContent.
 * Everything else (block accumulation, notifications, chatId tracking)
 * is handled by BlockRenderer in the SDK.
 */

import {
  BlockRenderer,
  type BlockKind,
  type VerboseConfig,
} from "@vibearound/plugin-channel-sdk";
import type { DiscordBot } from "./bot.js";

type LogFn = (level: string, msg: string) => void;

export class AgentStreamHandler extends BlockRenderer<string> {
  private discordBot: DiscordBot;
  private log: LogFn;

  constructor(discordBot: DiscordBot, log: LogFn, verbose?: Partial<VerboseConfig>) {
    super({
      streaming: true,
      flushIntervalMs: 500,
      minEditIntervalMs: 1000,
      verbose,
    });
    this.discordBot = discordBot;
    this.log = log;
  }

  protected async sendText(chatId: string, text: string): Promise<void> {
    await this.discordBot.sendMessage(chatId, text);
  }

  protected async sendBlock(chatId: string, _kind: BlockKind, content: string): Promise<string | null> {
    try {
      return await this.discordBot.sendMessage(chatId, content);
    } catch (e) {
      this.log("error", `sendBlock failed: ${e}`);
      return null;
    }
  }

  protected async editBlock(
    chatId: string,
    ref: string,
    _kind: BlockKind,
    content: string,
    _sealed: boolean,
  ): Promise<void> {
    try {
      await this.discordBot.editMessage(chatId, ref, content);
    } catch (e) {
      this.log("error", `editBlock failed: ${e}`);
    }
  }
}
