# ☕ Java Review — Lens Skill Pack

## [correctness]
- Overriding `equals` without `hashCode` (or vice versa); mutable fields in `hashCode`.
- `==` on objects (should be `.equals` unless reference equality is explicitly intended).
- `Optional.get()` without `.isPresent()` or `.orElse()` — throws on empty.
- `Optional` as a field type (intended for return types only).
- Side effects inside `Stream.map`/`filter`/`forEach`; `peek` used for non-debug purposes.
- Returning `null` for collections (should return `Collections.emptyList()` etc.).
- `String` concatenation in loops (use `StringBuilder`).
- Missing `@Nullable`/`@NonNull` on public APIs in projects that use null-safety annotations.

## [security]
- SQL built via string concatenation (use `PreparedStatement`).
- Catching `Exception`/`Throwable` broadly — swallows unexpected failures.
- Silently swallowed exceptions (`catch(Exception e) {}`).
- `Thread.sleep` in production code paths (fragile timing, not cancellable).
- Raw types instead of generics (type safety lost at boundaries).

## [data_integrity]
- Missing `try-with-resources` for `Closeable` (streams, connections, statements, result sets).
- Returning internal `List`/`Map`/`Date` directly from getters — callers can mutate internal state.
- Constructor stores mutable collection without defensive copy.
- `HashMap` where `ConcurrentHashMap` is needed (concurrent access).
- Modifying a collection during iteration (ConcurrentModificationException).
- Mutable static fields (shared state across threads without synchronization).
- **Spring**: `@Transactional` on private or self-invoked methods (proxy won't intercept).
- **Spring**: Lazy entity access outside session (LazyInitializationException).
- **Spring**: Missing `@Transactional(readOnly=true)` on read-only methods (missed DB optimization).

## [api_contracts]
- **Spring**: Field `@Autowired` instead of constructor injection (harder to test, hidden dependencies).
- Changed public method signatures without updating callers.
- NPE risk: dereferencing values from `Map.get` without null check.
- Changed exception types that callers might be catching.

## [maintainability]
- Import order and brace style are NOT worth commenting on.
- JavaDoc presence is NOT worth commenting on (unless on library public API).
- Deeply nested if/else chains that should use early returns or strategy pattern.
