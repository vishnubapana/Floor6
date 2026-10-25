# Floor6 Delegation Runtime

Floor6 treats delegation as a runtime decision, not task decomposition.

## Rule

The current agent owns its goal and should do the work itself unless a bounded subgoal gains a concrete execution advantage from isolation, parallelism, specialization, or context compression.

Goals flow down. Results flow up. Working context stays local.

## Delegate contract

`delegate` accepts:

- `goal`: the bounded outcome the child owns.
- `why`: the concrete reason a separate context is useful.
- `expected_result`: the compact contract returned to the parent.
- `context`: optional minimum viable context needed to begin.
- `capabilities`: optional advisory capability requirements.
- `background`: optional parallel execution for independent work.

The parent does not select a named specialist. Floor6 chooses an available execution agent and creates a fresh child session. The child inherits the selected execution agent's model (or the parent's model when none is configured) but not the parent's transcript.

## Execution

1. Parent submits a delegation request.
2. Floor6 policy accepts or rejects it.
3. Existing OpenCode depth and permission boundaries are enforced.
4. Floor6 chooses an available non-primary execution agent, preferring `general` when present.
5. A fresh child session is created.
6. The child receives a compiled prompt containing its goal, reason, return contract, requested capabilities, and minimal initial context.
7. The child executes using the existing session/job runtime.
8. Its final result returns to the parent; background work uses the existing subagent notification path.
9. A child can recursively request delegation only through the same Floor6 tool and configured depth limit.

## V0 boundary

Capabilities are advisory in V0. Existing agent permissions remain the enforcement boundary. Dynamic tool/skill grants, durable project knowledge, model routing, and richer context retrieval are later layers and should build on this contract rather than replace it.
