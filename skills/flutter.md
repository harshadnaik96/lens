# 🐦 Flutter / Dart Review — Lens Skill Pack

## Quality bar
- Only comment if a senior Flutter engineer's first reaction would be "good catch," not "yeah I know."
- Don't comment on: widget naming conventions, trailing commas, formatting, anything `dart format` or `flutter analyze` handles.

## [correctness]
- Missing `await` on `Future`-returning calls — silently drops errors and returns before work completes.
- `async` methods that `await` nothing — the `async` keyword is pointless and misleading.
- `setState` called after `dispose` — guard with `if (!mounted) return` before every `setState` after an `await`.
- `BuildContext` used across `await` gaps without a `mounted` check — context may be stale.
- Force-unwrapped nullable (`!`) on values that can actually be null at runtime (API responses, map lookups, nullable fields).
- `initState` directly calling `async` methods that use `context` — use `addPostFrameCallback` instead.
- `StreamController` not closed in `dispose` — memory/resource leak.
- `AnimationController` not disposed — leaks a ticker.
- `TextEditingController` / `FocusNode` / `ScrollController` not disposed.
- `CancelableOperation` or subscription not cancelled in `dispose`.
- `FutureBuilder` / `StreamBuilder` with a `future`/`stream` that is recreated every build — causes infinite rebuild loops; hoist to a field or use a state management solution.
- `key` missing on widgets in a list where items can be reordered or removed — causes wrong widget matched to wrong state.
- `const` constructor called with non-const arguments — silently falls back to non-const, missing the optimization.
- `Navigator.pop` called without checking `Navigator.canPop` when the route may be the root.

## [security]
- Secrets, API keys, or tokens hardcoded in Dart source or `pubspec.yaml`.
- `dart:io` `Process.run` / `Process.start` with string interpolation of user-controlled input (command injection).
- Sensitive data (tokens, passwords, PII) stored in `SharedPreferences` or unencrypted local storage — use `flutter_secure_storage`.
- Deep-link or URI handler that trusts path/query parameters without validation.
- `webview_flutter` loading arbitrary URLs from untrusted input without scheme/host allowlist.
- `dart:mirrors` or `dart:ffi` used to access or mutate memory in security-sensitive contexts.
- Missing certificate pinning on network clients that handle sensitive data.

## [data_integrity]
- `Isolate.spawn` / `compute` passing objects that are not `SendPort`-safe (non-primitive, contains closures).
- State updated directly on a `ChangeNotifier` / `StateNotifier` / `Bloc` field without going through the proper mutation method — bypasses listeners.
- `Riverpod` provider family with mutable key objects — cache key identity will be unpredictable.
- `Bloc`/`Cubit` `emit` called after `close` — throws in debug, silently drops in release.
- Optimistic UI update without rollback on failure.
- `sqflite` / `drift` write outside a transaction when atomicity is required.
- Shared `GlobalKey` between multiple widgets in the tree simultaneously — causes duplicate key assertion.

## [api_contracts]
- `dynamic` on public API boundaries of a widget, provider, or service — hides real type errors from callers.
- `required` parameter removed or made optional without bumping the package version — breaks existing callers.
- Named constructor or factory renamed without a deprecated forwarding constructor.
- `ChangeNotifier` subclass exposing mutable public fields that callers set directly instead of through methods — breaks notification guarantees.
- Platform channel method name changed without updating both Dart and native (iOS/Android) sides simultaneously.
- Breaking change to a `JsonSerializable` model (removed/renamed field) without a migration or `@JsonKey(name: ...)` alias.

## [maintainability]
- `build()` method longer than ~50 lines of widget tree — extract into named methods or separate `StatelessWidget` classes.
- Business logic inside `build()` or directly in a widget — move to a controller, provider, or bloc.
- `MediaQuery.of(context)` / `Theme.of(context)` called deep inside a large subtree on every rebuild — hoist to the top of `build` or use `select`.
- `setState` wrapping a large block that rebuilds the whole tree when only a small subtree needs updating.
- Magic numbers for sizes, durations, or colors — extract to constants or theme tokens.
- TODO/FIXME introduced in the diff without a tracking issue.
