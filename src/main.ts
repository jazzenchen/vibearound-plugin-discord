#!/usr/bin/env node
/**
 * VibeAround Discord Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 */

import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";

import { DiscordBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

runChannelPlugin({
  name: "vibearound-discord",
  version: "0.1.0",
  requiredConfig: ["bot_token"],
  createBot: ({ config, agent, log, cacheDir }) =>
    new DiscordBot(config.bot_token as string, agent, log, cacheDir),
  afterCreate: async (bot, log) => {
    const botInfo = await bot.probe();
    log("info", `bot identity: @${botInfo.username} (${botInfo.id})`);
  },
  createRenderer: (bot, log, verbose) =>
    new AgentStreamHandler(bot, log, verbose),
  // Heartbeat health check — gateway ws ready + latency under 10s. Discord
  // keeps its own reconnect logic; we just confirm the socket's alive.
  healthCheck: async (bot) => {
    if (!bot.client.isReady()) return false;
    const ping = bot.client.ws.ping ?? -1;
    return ping >= 0 && ping < 10_000;
  },
});
