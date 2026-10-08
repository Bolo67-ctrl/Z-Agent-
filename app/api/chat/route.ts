import { streamText, convertToModelMessages } from "ai";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: "openai/gpt-5.5",
    system:
      "You are Z-Agent, a capable general-purpose AI agent. Be helpful, clear, and honest. " +
      "Think through tasks carefully, but do not expose private chain-of-thought. " +
      "When a task needs information you do not have, say what is missing.",
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
