export * as Delegation from "./delegation.js"

import { Schema } from "effect"

export const Request = Schema.Struct({
  goal: Schema.String.check(Schema.isMinLength(1)),
  why: Schema.String.check(Schema.isMinLength(1)),
  expectedResult: Schema.String.check(Schema.isMinLength(1)),
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Request = typeof Request.Type

export const Decision = Schema.Union(
  Schema.Struct({
    delegate: Schema.Literal(true),
    reason: Schema.String,
  }),
  Schema.Struct({
    delegate: Schema.Literal(false),
    reason: Schema.String,
  }),
)
export type Decision = typeof Decision.Type

export function evaluate(request: Request): Decision {
  const goal = request.goal.trim()
  const why = request.why.trim()
  const expectedResult = request.expectedResult.trim()
  if (!goal || !why || !expectedResult)
    return {
      delegate: false,
      reason: "Delegation requires a bounded goal, a concrete execution advantage, and an explicit result contract.",
    }

  return {
    delegate: true,
    reason: "The request defines a bounded goal and explicit result contract. The child may execute in isolated context.",
  }
}
