# 🔷 GraphQL Review — Lens Skill Pack

## Quality bar
- Only comment if a senior API engineer's first reaction would be "good catch," not "yeah I know."
- Don't comment on: field naming conventions, description copy, formatting, anything a GraphQL linter handles.

## [correctness]
- Resolver returns `null` for a field typed as non-null (`!`) — causes the error to bubble up and null out the nearest nullable parent, potentially wiping large portions of the response.
- `async` resolver that doesn't `await` the data source call — returns a Promise object instead of the resolved value.
- Missing null check before accessing a nested field on a resolver result that may be null.
- List resolver returning a single object instead of an array (or vice versa) — type mismatch at runtime.
- Mutation resolver that does not return the mutated object/type declared in the schema — clients relying on the response get `null`.
- Input validation skipped — trusting GraphQL type coercion alone (e.g., `String` does not validate email format or length).
- Subscription resolver that does not handle cleanup on client disconnect — resource/memory leak.

## [security]
- No query depth limit — deeply nested queries (`{ a { b { a { b { … } } } } }`) cause exponential resolver fan-out (DoS).
- No query complexity limit — single query selecting thousands of fields exhausts server resources.
- No rate limiting or persisted-query enforcement on the GraphQL endpoint.
- Introspection left enabled in production — exposes full schema to attackers.
- Field-level authorization missing — authenticated users can query fields they shouldn't access by constructing their own queries.
- Resolver using user-supplied arguments directly in a raw database query without parameterization — injection risk.
- `__typename` or internal implementation details leaked in error messages.
- Batched query abuse (query batching without per-batch limits) — amplifies any of the above.

## [data_integrity]
- N+1 in resolvers — each parent object triggers a separate child data-source call; use DataLoader or equivalent batching.
- Mutation that modifies shared state without optimistic locking or conflict detection when concurrent edits are possible.
- Subscription that holds an open DB connection or cursor per subscriber without a pool limit — connection exhaustion under load.
- Cache (Apollo, urql, etc.) key collision — two different objects share the same `id` + `__typename` pair.
- Relay-style pagination cursor not stable across mutations — items skipped or duplicated when the underlying list changes mid-page.

## [api_contracts]
- Field removed from the schema without a deprecation period (`@deprecated(reason: "…")`).
- Field type changed to a breaking type (e.g., `String` → `Int`, nullable → non-null) without a major version.
- Argument added as required (non-null) to an existing field — breaks all existing queries that omit it.
- Enum value removed or renamed — breaks clients that pattern-match on the old value.
- Input type field made required that was previously optional.
- `@deprecated` field removed before checking client adoption / query analytics.
- Mutation name or return type changed — breaks generated client code.

## [maintainability]
- Resolver contains business logic that should live in a service layer — couples schema shape to implementation.
- Schema split across many files without a clear ownership boundary — hard to find where a type is defined.
- Deeply nested fragment spreads (>4 levels) — hard to reason about what data is actually fetched.
- Custom scalar without a documented serialization/parsing contract.
- TODO/FIXME in schema SDL or resolver without a tracking issue.
