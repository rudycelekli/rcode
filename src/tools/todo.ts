import { z } from "zod";
import type { Tool } from "../agent/types.ts";
import { text } from "./util.ts";

export interface Todo { content: string; status: "pending" | "in_progress" | "completed"; }

const schema = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })).describe("The full, updated todo list (replaces the previous one)"),
});

export const todoTool: Tool<typeof schema> = {
  name: "todo",
  label: "Todos",
  description: "Maintain a visible task list for multi-step work. Send the whole list each time; keep exactly one item in_progress. Skip for trivial single-step tasks.",
  schema,
  concurrency: "exclusive",
  effects: { readOnly: true },
  summarize: (a) => `${a.todos.filter((t) => t.status === "completed").length}/${a.todos.length} done`,
  async execute(a, ctx) {
    ctx.state.set("todos", a.todos);
    const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
    return text(a.todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n") || "(empty)", false, { todos: a.todos });
  },
};
