import { stream, resolveModel, apiKeyFor } from "../src/ai/index.ts";
const ref = process.argv[2] ?? "openai/gpt-5-mini";
const model = resolveModel(ref)!;
const tools = [{ name: "get_weather", description: "Get weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
const s = stream(model, { systemPrompt: "You are terse.", messages: [{ role: "user", content: [{ type: "text", text: "What's the weather in Paris? Use the tool." }], timestamp: Date.now() }], tools }, { apiKey: apiKeyFor(model), thinking: "low" });
for await (const e of s) if (e.type === "text_delta") process.stdout.write(e.delta); else if (e.type === "toolcall_end") console.log("\nTOOL", e.toolCall);
const m = await s.result();
console.log("\nstop:", m.stopReason, m.errorMessage ?? "", "usage:", m.usage.input, m.usage.output, "$" + m.usage.cost.total.toFixed(5));
