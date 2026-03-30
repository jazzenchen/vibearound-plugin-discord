#!/usr/bin/env node
/**
 * VibeAround Discord Plugin — ACP Client
 *
 * Spawned by the Rust host as a child process.
 * Communicates via ACP protocol (JSON-RPC 2.0 over stdio).
 *
 * Plugin = ACP Client, Host = ACP Agent.
 * Plugin sends prompt() with Discord channelId as sessionId.
 * Host streams back via sessionUpdate notifications.
 */

import os from "node:os";
import path from "node:path";
import {
  connectToHost,
  normalizeExtMethod,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@vibearound/plugin-channel-sdk";

import { DiscordBot } from "./bot.js";
import { AgentStreamHandler } from "./agent-stream.js";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let streamHandler: AgentStreamHandler | null = null;

function log(level: string, msg: string): void {
  process.stderr.write(`[discord-plugin][${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Initialize — get channel config from host and start
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  log("info", "initializing ACP connection...");

  const { agent, meta, agentInfo, conn } = await connectToHost(
    { name: "vibearound-discord", version: "0.1.0" },
    (_a) => ({
      async sessionUpdate(params: SessionNotification): Promise<void> {
        streamHandler?.onSessionUpdate(params);
      },

      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        const first = params.options?.[0];
        if (first) {
          return { outcome: { outcome: "selected", optionId: first.optionId } };
        }
        throw new Error("No permission options provided");
      },

      async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
        switch (normalizeExtMethod(method)) {
          case "channel/system_text": {
            const text = params.text as string;
            streamHandler?.onSystemText(text);
            break;
          }
          case "channel/agent_ready": {
            const agentName = params.agent as string;
            const version = params.version as string;
            log("info", `agent_ready: ${agentName} v${version}`);
            streamHandler?.onAgentReady(agentName, version);
            break;
          }
          case "channel/session_ready": {
            const sessionId = params.sessionId as string;
            log("info", `session_ready: ${sessionId}`);
            streamHandler?.onSessionReady(sessionId);
            break;
          }
          default:
            log("warn", `unhandled ext_notification: ${method}`);
        }
      },
    }),
  );

  const config = meta.config;
  const botToken = config.bot_token as string;
  const cacheDir = meta.cacheDir ?? path.join(os.homedir(), ".vibearound", ".cache");

  if (!botToken) {
    throw new Error("bot_token is required in Discord config");
  }

  log("info", `initialized, host=${agentInfo.name ?? "unknown"} cacheDir=${cacheDir}`);

  // Parse verbose config
  const verbose = (config as unknown as Record<string, unknown>).verbose as
    | { show_thinking?: boolean; show_tool_use?: boolean }
    | undefined;

  // Create Discord bot
  const discordBot = new DiscordBot(botToken, agent, log, cacheDir);
  const botInfo = await discordBot.probe();
  log("info", `bot identity: ${botInfo.username} (${botInfo.id})`);

  // Create stream handler
  streamHandler = new AgentStreamHandler(discordBot, log, {
    showThinking: verbose?.show_thinking ?? false,
    showToolUse: verbose?.show_tool_use ?? false,
  });
  discordBot.setStreamHandler(streamHandler);

  log("info", "plugin started");

  // Wait for connection to close
  await conn.closed;
  log("info", "connection closed, shutting down");
  discordBot.stop();
  process.exit(0);
}

start().catch((error) => {
  log("error", `fatal: ${error}`);
  process.exit(1);
});
