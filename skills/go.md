# 🐹 Go Review — Lens Skill Pack

## [correctness]
- Every returned `error` must be checked or explicitly discarded with `_ =`.
- Returning raw `err` when `fmt.Errorf("...: %w", err)` would preserve context.
- Checking error *after* using the value (use value only if err == nil).
- Writing to nil map (runtime panic).
- Nil pointer dereferences after type assertion without `, ok` check.
- Returning nil interface that compares non-nil (typed nil bug).
- `defer` inside `for` loop — resource leak; move to helper function or explicit close.
- Slice aliasing: returning a slice that shares underlying array with internal state.
- `append` reusing underlying array unexpectedly when slice has spare capacity.

## [security]
- String concatenation in SQL queries (use parameterized queries).
- `panic` in library code (acceptable only in `main` or truly unrecoverable cases).
- Unsanitized user input in `os/exec.Command` arguments.
- Missing TLS verification on HTTP clients (`InsecureSkipVerify: true`).

## [data_integrity]
- Goroutines launched without a way to stop them (no `context`, no done channel, no `sync.WaitGroup`).
- Mutex held across I/O calls (blocking other goroutines on network latency).
- Struct with `sync.Mutex` field used as value receiver or copied — silent data race.
- `context.Background()` used inside a request handler instead of the request context.
- Missing channel direction constraints in function signatures (`<-chan` / `chan<-`).
- Map access without checking `ok` in concurrent code (even reads on shared maps aren't safe without sync).

## [api_contracts]
- Context accepted by function but not propagated to downstream calls (DB, HTTP, RPC).
- Exported function signature changed without considering callers.
- Changed error types or error wrapping that breaks `errors.Is`/`errors.As` chains.

## [maintainability]
- `gofmt`-fixable issues are NOT worth commenting on.
- Godoc comment formatting is NOT worth commenting on.
- Functions with deeply nested if/else that could be flattened with early returns.
