import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const tools = {
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
      "Use tools when they improve accuracy. Do not expose private chain-of-thought. " +
      "Never claim a tool was used if it was not.",
    tools,
    stopWhen: stepCountIs(5),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
