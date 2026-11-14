#!/usr/bin/env node
/**
 * MCP stdio → Streamable HTTP bridge.
 *
 * For clients that only speak stdio (Claude Desktop, some IDE agents) while
 * Qexo runs as a remote Worker. Zero dependencies.
 *
 *   QEXO_MCP_URL=https://qexo.example.com/mcp \
 *   QEXO_MCP_TOKEN=qx_mcp_xxx \
 *   node mcp/stdio-bridge.mjs
 */

import readline from "node:readline";

const url = process.env.QEXO_MCP_URL;
const token = process.env.QEXO_MCP_TOKEN;

if (!url || !token) {
  console.error("QEXO_MCP_URL and QEXO_MCP_TOKEN are required");
  process.exit(1);
}

let protocolVersion = "2025-06-18";
let sessionId = "";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function forward(message) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": protocolVersion,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  } catch (error) {
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `bridge: ${error.message}` } });
    }
    return;
  }

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (res.status === 202) return;

  const text = await res.text();
  if (!text) {
    if (message.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: `bridge: HTTP ${res.status} with empty body` },
      });
    }
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32700, message: "bridge: invalid JSON from server" } });
    return;
  }

  if (message.method === "initialize" && payload?.result?.protocolVersion) {
    protocolVersion = payload.result.protocolVersion;
  }
  if (payload && (payload.id !== undefined || payload.error)) send(payload);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bridge: parse error" } });
    return;
  }
  forward(message).catch((error) => {
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message || error) } });
    }
  });
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
