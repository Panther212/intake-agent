import "server-only";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

/** Ask Gemini for JSON matching `schema`; validates with zod and retries once. */
export async function generateJson<T extends z.ZodType>(opts: {
  schema: T;
  system: string;
  prompt: string;
}): Promise<z.infer<T>> {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(opts.schema) as Record<string, unknown>;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: opts.prompt,
        config: {
          systemInstruction: opts.system,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          temperature: 0.3,
        },
      });
      return opts.schema.parse(JSON.parse(res.text ?? ""));
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`LLM JSON generation failed: ${String(lastError)}`);
}
