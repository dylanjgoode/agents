/**
 * Copyright 2026 MongoDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { AtlasExplorerChat } from "./runtime.js";

export const WEBHOOK_PATH = "/api/webhooks/whatsapp";

export interface LocalWebhookServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Serves the WhatsApp webhook on localhost for development. Meta only calls
 * public HTTPS URLs, so put a tunnel in front of it. Work started by a
 * webhook is tracked and awaited on close.
 */
export async function startLocalWebhookServer(
  bot: AtlasExplorerChat,
  options: { host?: string; port?: number } = {},
): Promise<LocalWebhookServer> {
  const host = options.host ?? "127.0.0.1";
  const pending = new Set<Promise<unknown>>();
  const waitUntil = (task: Promise<unknown>): void => {
    const tracked = task.catch(() => undefined).finally(() => {
      pending.delete(tracked);
    });
    pending.add(tracked);
  };
  const server = createServer((request, response) => {
    void handleRequest(bot, waitUntil, request, response).catch(
      (error: unknown) => {
        console.error("WhatsApp webhook request failed", error);
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain" });
        }
        response.end();
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local webhook server did not bind a TCP port");
  }

  return {
    url: `http://${host}:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.allSettled(pending);
    },
  };
}

async function handleRequest(
  bot: AtlasExplorerChat,
  waitUntil: (task: Promise<unknown>) => void,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (
    url.pathname !== WEBHOOK_PATH ||
    (request.method !== "GET" && request.method !== "POST")
  ) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  let body: Buffer | undefined;
  if (request.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    body = Buffer.concat(chunks);
  }

  const webhookResponse = await bot.webhooks.whatsapp(
    new Request(url, {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
    }),
    { waitUntil },
  );

  const responseHeaders: Record<string, string> = {};
  webhookResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-length") {
      responseHeaders[key] = value;
    }
  });
  response.writeHead(webhookResponse.status, responseHeaders);
  response.end(Buffer.from(await webhookResponse.arrayBuffer()));
}
