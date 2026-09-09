import OpenAI from "openai";
import { executeTool, tools } from "./tools.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `
You are a small coding agent.

You work inside the current project directory.

You can:
- inspect directories
- read files
- execute shell commands

Use tools whenever needed to answer the user's request.
Do not claim that you inspected something unless you actually used a tool.

When you have enough information, answer the user.
`;

export async function runAgent(userPrompt: string) {
  const input: any[] = [
    {
      role: "user",
      content: userPrompt,
    },
  ];

  for (let step = 0; step < 20; step++) {
    console.log(`\n[agent step ${step + 1}]`);

    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
      instructions: SYSTEM_PROMPT,
      tools,
      input,
    });

    //
    // VERY IMPORTANT:
    //
    // Everything produced by the model becomes part
    // of the current agent run's context.
    //
    input.push(...response.output);

    const toolCalls = response.output.filter(
      (item: any) => item.type === "function_call",
    );

    //
    // No tool calls = model decided it is finished.
    //
    if (toolCalls.length === 0) {
      return response.output_text;
    }

    //
    // Execute every requested tool.
    //
    for (const call of toolCalls) {
      console.log(
        `[tool] ${call.name}(${call.arguments})`,
      );

      let args: unknown;

      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = {};
      }

      const result = await executeTool(
        call.name,
        args,
      );

      console.log(
        `[tool result] ${truncate(result, 300)}`,
      );

      //
      // THIS IS THE CRITICAL PART.
      //
      // We send the result of our JS function
      // back to the model.
      //
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: result,
      });
    }
  }

  throw new Error("Agent exceeded maximum steps");
}

function truncate(text: string | undefined, max: number) {
  if (!text || text.length <= max) {
    return text;
  }

  return text.slice(0, max) + "...";
}