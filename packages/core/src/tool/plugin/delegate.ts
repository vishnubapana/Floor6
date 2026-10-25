export * as DelegateTool from "./delegate.js"

import { ToolFailure } from "@opencode/ai/effect"
import { SystemPart } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Delegation } from "../../delegation.js"
import { Job } from "../../job.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"

export const name = "delegate"

export const Input = Schema.Struct({
  goal: Schema.String.annotate({ description: "A bounded outcome for the child to own." }),
  why: Schema.String.annotate({
    description: "Why isolation/delegation is better than completing this work in the current context.",
  }),
  expected_result: Schema.String.annotate({
    description: "The compact result contract the child must return to its parent.",
  }),
  context: Schema.optionalKey(Schema.String).annotate({
    description: "Only the minimum additional context the child needs to begin. Do not paste the parent transcript.",
  }),
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Capabilities likely needed by the child. This is advisory in V0 and is recorded in its prompt.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Run independent non-overlapping work in the background.",
  }),
})

export const Output = Schema.Struct({
  sessionID: Schema.optionalKey(SessionSchema.ID),
  status: Schema.Literals(["completed", "running", "rejected"]),
  output: Schema.String,
})

const instructions = [
  "You are an ephemeral Floor6 execution agent. You own only the delegated goal below.",
  "Work independently using the capabilities available in this session.",
  "Do not broaden the goal. If more work is independently delegable, use delegate under the same minimal-delegation rule.",
  "Return a compact result to the parent. Include status, deliverables or findings, changed files when applicable, important interfaces/constraints, tests/evidence, and blockers.",
].join("\n")

export const Plugin = {
  id: "floor6.tool.delegate",
  effect: Effect.fn("DelegateTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const subagents = yield* SubagentJob.Service

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false },
        description: [
          "Delegate a bounded goal to an isolated Floor6 child agent.",
          "Default to doing work yourself. Delegate only when isolation, parallelism, specialization, or context compression gives a concrete execution advantage.",
          "The child receives a fresh context containing the goal, explicit return contract, and only context you provide here.",
        ].join("\n"),
        input: Input,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            const decision = Delegation.evaluate({
              goal: input.goal,
              why: input.why,
              expectedResult: input.expected_result,
              capabilities: input.capabilities,
            })
            if (!decision.delegate)
              return {
                output: { status: "rejected" as const, output: decision.reason },
                content: `Delegation rejected: ${decision.reason} Continue in the current agent.`,
                metadata: { status: "rejected" as const },
              }

            const parent = yield* sessions.get(context.sessionID).pipe(
              Effect.mapError((error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error })),
            )
            let current = parent
            let depth = 0
            while (current.parentID) {
              depth++
              current = yield* sessions.get(current.parentID).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error })),
              )
            }
            const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
            if (depth >= limit)
              return yield* new ToolFailure({
                message: `Delegation depth limit reached (${limit}). Increase experimental.subagent_depth to allow recursive delegation.`,
              })

            const available = (yield* agents.list()).filter(
              (agent) => agent.mode !== "primary" && !agent.hidden && Permission.evaluate("subagent", agent.id, parent.permissions).effect !== "deny",
            )
            const agent = available.find((candidate) => candidate.id === "general") ?? available[0]
            if (!agent) return yield* new ToolFailure({ message: "No execution agent is available for delegation." })

            yield* permission.assert({
              action: "subagent",
              resources: [agent.id],
              save: [agent.id],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: `Delegation denied: ${agent.id}`, error })))

            const child = yield* sessions.create({
              parentID: context.sessionID,
              title: input.goal.slice(0, 80),
              agent: agent.id,
              model: agent.model ?? parent.model,
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: "Failed to create delegated session", error })))

            const prompt = [
              instructions,
              "",
              `GOAL\n${input.goal.trim()}`,
              "",
              `WHY DELEGATED\n${input.why.trim()}`,
              "",
              `RETURN CONTRACT\n${input.expected_result.trim()}`,
              input.capabilities?.length ? `\nREQUESTED CAPABILITIES\n${input.capabilities.join("\n")}` : "",
              input.context?.trim() ? `\nINITIAL CONTEXT\n${input.context.trim()}` : "",
            ].filter(Boolean).join("\n")

            const background = input.background === true
            yield* context.progress({ sessionID: child.id, status: "running", goal: input.goal })
            yield* sessions.prompt({ sessionID: child.id, text: prompt, ...(background ? { resume: false } : {}) }).pipe(
              Effect.mapError((error) => new ToolFailure({ message: `Failed to prompt delegated session: ${child.id}`, error })),
            )

            const recovery = {
              kind: "subagent" as const,
              parentSessionID: context.sessionID,
              childSessionID: child.id,
              agent: agent.name,
              description: input.goal.slice(0, 80),
            }
            yield* subagents.start(recovery)
            if (background) {
              yield* subagents.background(recovery)
              const output = `Delegated goal is running in the background (sessionID: ${child.id}). Do not duplicate its work.`
              return { output: { sessionID: child.id, status: "running" as const, output }, content: output, metadata: { sessionID: child.id, status: "running" as const } }
            }

            const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
              Effect.onInterrupt(() => Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], { discard: true })),
            )
            if (result?.type === "backgrounded") {
              yield* subagents.notify(recovery, result.info.started_at)
              const output = `Delegated goal moved to the background (sessionID: ${child.id}).`
              return { output: { sessionID: child.id, status: "running" as const, output }, content: output, metadata: { sessionID: child.id, status: "running" as const } }
            }
            if (result?.info.status === "error") return yield* new ToolFailure({ message: `Delegated agent failed: ${result.info.error ?? "unknown error"}` })
            if (result?.info.status === "cancelled") return yield* new ToolFailure({ message: `Delegated agent cancelled: ${child.id}` })
            const output = result?.info.output ?? SubagentCompletion.NO_TEXT
            return {
              output: { sessionID: child.id, status: "completed" as const, output },
              content: `<delegation sessionID="${child.id}" state="completed">\n${output}\n</delegation>`,
              metadata: { sessionID: child.id, status: "completed" as const },
            }
          }),
      }),
    ).pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) => Effect.sync(() => {
      if (!event.tools[name]) return
      event.system.push(SystemPart.make([
        "Floor6 delegation policy:",
        "- You own the current goal. Default to doing the work yourself.",
        "- Do not delegate merely because work can be decomposed.",
        "- Delegate when a bounded subgoal benefits materially from isolation, parallel execution, specialization, or context compression.",
        "- Pass minimum viable context and an explicit return contract; never copy the full conversation.",
        "- Prefer disclose context/load skill/grant capability before delegation when that keeps responsibility coherent.",
      ].join("\n")))
    })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
