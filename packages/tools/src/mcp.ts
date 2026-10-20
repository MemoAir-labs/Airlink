import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// A tool a host serves to an agent harness: JSON Schema parameters and a runner that never throws.
export type ServedTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown): Promise<{ ok: boolean; text: string }>;
};

// zod-to-json-schema stamps draft-07's `$schema`; model APIs validate tool schemas as draft
// 2020-12. The definitions avoid tuples (the one construct that differs), so dropping the stamp
// is all that is left.
export const jsonParameters = (
  schema: z.ZodRawShape
): Record<string, unknown> => {
  const { $schema: _draft, ...parameters } = zodToJsonSchema(z.object(schema), {
    $refStrategy: "none",
  });
  return parameters;
};

// A harness reaches tools as one MCP server served on loopback. Each session gets its own bearer,
// bound to tools that already carry the agent's identity and scope, so a harness can never call
// into another session's room or memory.
export function serveToolsMcp({ name }: { name: string }) {
  const tokens = new Map<string, string>();
  const bindings = new Map<string, ServedTool[]>();
  let url = "";

  const http: HttpServer = createServer((req, res) => {
    const tools = bindings.get(
      (req.headers.authorization ?? "").replace(/^Bearer /, "")
    );
    if (!tools) {
      res.writeHead(401).end();
      return;
    }
    const server = new Server(
      { name, version: "0.0.0" },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.parameters, type: "object" as const },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = tools.find((each) => each.name === request.params.name);
      const result = tool
        ? await tool.run(request.params.arguments ?? {})
        : { ok: false, text: `No room tool named ${request.params.name}.` };
      return {
        content: [{ type: "text", text: result.text }],
        isError: !result.ok,
      };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
  });

  return {
    async listen(): Promise<string> {
      await new Promise<void>((resolve) =>
        http.listen(0, "127.0.0.1", resolve)
      );
      const address = http.address();
      url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
      return url;
    },

    // The same session keeps its bearer across turns; each turn rebinds the tools it may use.
    bind(sessionKey: string, tools: ServedTool[]) {
      const token = tokens.get(sessionKey) ?? randomUUID();
      tokens.set(sessionKey, token);
      bindings.set(token, tools);
      return {
        type: "http" as const,
        name,
        url,
        headers: [{ name: "authorization", value: `Bearer ${token}` }],
      };
    },

    close() {
      http.close();
    },
  };
}

export type ToolsMcp = ReturnType<typeof serveToolsMcp>;
