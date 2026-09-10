import "dotenv/config";
import OpenAI from "openai";

async function main() {
  const client = new OpenAI({ apiKey: process.env.NVIDIA_API_KEY, baseURL: process.env.NVIDIA_BASE_URL });

  const model = process.argv[2] ?? process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b";
  const thinking = (process.argv[3] ?? process.env.NVIDIA_THINKING ?? "true") !== "false";

  console.log(`model=${model} thinking=${thinking}`);
  const startedAt = Date.now();
  try {
    const res = await client.chat.completions.create(
      {
        model,
        temperature: 0.2,
        max_tokens: 500,
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
        chat_template_kwargs: { thinking, enable_thinking: thinking },
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { maxRetries: 0, timeout: 120_000 },
    );
    console.log(`OK in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log("finish_reason:", res.choices[0]?.finish_reason);
    console.log("content:", res.choices[0]?.message?.content);
    console.log("usage:", res.usage);
  } catch (error: any) {
    console.log(`FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log("name:", error?.name, "status:", error?.status);
    console.log("message:", error?.message);
  }
}

main();
