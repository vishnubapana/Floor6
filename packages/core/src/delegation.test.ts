import { describe, expect, it } from "bun:test"
import { Delegation } from "./delegation.js"

describe("Delegation.evaluate", () => {
  it("accepts a bounded delegation contract", () => {
    expect(
      Delegation.evaluate({
        goal: "Inspect the authentication boundary",
        why: "The investigation is independent and would otherwise pollute the implementation context",
        expectedResult: "Relevant files, mapping, constraints, and confidence",
      }).delegate,
    ).toBe(true)
  })

  it("rejects incomplete contracts", () => {
    expect(
      Delegation.evaluate({
        goal: "Inspect auth",
        why: "",
        expectedResult: "Findings",
      }).delegate,
    ).toBe(false)
  })
})
