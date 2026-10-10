import { createGoogle } from "@ai-sdk/google";

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";

export const gemini = createGoogle({
  apiKey: process.env.GEMINI_API_KEY,
});
