import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const tools = {
  webSearch: tool({
    description:
      "Search the live web for current, changing, niche, or source-sensitive information. Use this before answering questions where up-to-date sources matter.",
    inputSchema: z.object({
      query: z.string().min(2).describe("A focused web search query."),
      numResults: z.number().int().min(1).max(8).optional().describe("Number of results to return."),
    }),
    execute: async ({ query, numResults = 5 }) => {
      const apiKey = process.env.EXA_API_KEY;
      if (!apiKey) {
        return { error: "Web search is not configured. Set EXA_API_KEY on the server." };
      }

      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          numResults,
          contents: { text: { maxCharacters: 6000 } },
        }),
        cache: "no-store",
      });

      if (!response.ok) {
        return { error: `Web search failed with HTTP ${response.status}.` };
      }

      const data = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          publishedDate?: string;
          text?: string;
        }>;
      };

      return {
        query,
        results: (data.results ?? []).map((item) => ({
          title: item.title ?? "",
          url: item.url ?? "",
          publishedDate: item.publishedDate ?? null,
          text: item.text ?? "",
        })),
      };
    },
  }),

  getCurrentTime: tool({
    description: "Get the current date and time. Use this when the user asks what time or date it is.",
    inputSchema: z.object({
      timeZone: z.string().optional().describe("IANA timezone such as America/New_York"),
    }),
    execute: async ({ timeZone }) => {
      const zone = timeZone || "UTC";
      const now = new Date();
      return {
        timeZone: zone,
        iso: now.toLocaleString("en-US", {
          timeZone: zone,
          dateStyle: "full",
          timeStyle: "long",
        }),
      };
    },
  }),

  calculator: tool({
    description: "Calculate a basic arithmetic expression. Use this for numerical calculations instead of mental arithmetic.",
    inputSchema: z.object({
      expression: z.string().describe("A basic arithmetic expression using numbers, +, -, *, /, %, parentheses, and decimals."),
    }),
    execute: async ({ expression }) => {
      if (!/^[0-9+\-*/%().\s]+$/.test(expression)) {
        return { error: "Only basic arithmetic characters are allowed." };
      }
      try {
        const value = Function(`"use strict"; return (${expression})`)();
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return { error: "The expression did not produce a finite number." };
        }
        return { expression, result: value };
      } catch {
        return { error: "Could not evaluate that expression." };
      }
    },
  }),
};

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: "openai/gpt-5.5",
    system:
      "You are Z-Agent, a capable general-purpose AI agent. Be helpful, clear, and honest. " +
      "Use tools when they improve accuracy. Use webSearch for current, changing, niche, or source-sensitive information. " +
      "When webSearch returns sources, ground factual claims in those sources and include useful source links in your answer. " +
      "Do not expose private chain-of-thought. Never claim a tool was used if it was not. " +
      "Respect authorization, privacy, and safety boundaries.",
    tools,
    stopWhen: stepCountIs(5),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
