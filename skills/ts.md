# 🛡️ TypeScript Review — Lens Skill Pack

## [correctness]
- Missing `await` on returned promises (fire-and-forget that silently drops errors).
- `await` inside `.forEach` — use `for...of` or `Promise.all` for sequential/parallel async.
- Independent `await`s in a loop that should be parallelized with `Promise.all`.
- `==` instead of `===` (type coercion bugs), `NaN === NaN` (always false).
- Comparing objects/arrays by reference when value comparison was intended.
- `new Date(string)` without explicit timezone — server/client mismatch risk.
- Stale closures over React state in useEffect/useCallback/useMemo.
- Missing or incorrect dependency arrays in React hooks.
- Conditional hook calls (hooks must be called unconditionally and in the same order).
- Missing `key` on list items in React, or using array index as key on reorderable lists.
- Derived state stored in `useState` when it should be computed during render.
- Unhandled promise rejections in non-async event handlers.

## [security]
- `eval()`, `Function()` constructor, or `new Function()` with dynamic input.
- Unsanitized template literals interpolated into SQL, HTML, or shell commands.
- `child_process.exec/execSync` with string interpolation (command injection).
- `dangerouslySetInnerHTML` with unsanitized input.
- `JSON.parse` on untrusted input without try/catch.

## [data_integrity]
- Shared module-level mutable state (module singletons mutated by multiple callers).
- Direct mutation of React props, state, or Redux store (should return new values).
- Mutating function parameters instead of returning new objects.
- `Map`/`Set`/`Array` shared between async operations without synchronization.

## [api_contracts]
- `any` escape hatches that hide real type errors on exported/public functions.
- `as` type assertions that bypass narrowing (especially `as unknown as T`).
- Non-null assertions (`!`) on values that can actually be null at runtime.
- Missing return types on exported functions.
- `@ts-ignore` / `@ts-expect-error` without an explanatory comment.
- Enums when a union of string literals would be more type-safe and tree-shakeable.
- `Promise` returned from a function whose signature declares `void`.
- Unnecessarily widened return types on public APIs.

## [maintainability]
- Deep imports that break tree-shaking (`import _ from 'lodash'` instead of `import map from 'lodash/map'`).
- Default-importing large libraries when only one function is used.
- Deeply nested callbacks (>3 levels) that should be flattened.
