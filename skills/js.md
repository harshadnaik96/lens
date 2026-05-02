# 📜 JavaScript Review — Lens Skill Pack

## [correctness]
- `==` instead of `===` unless intentional (type coercion bugs).
- `var` usage (use `let`/`const` — hoisting and scope bugs).
- Missing `await` on returned promises (fire-and-forget).
- `await` inside `.forEach` — use `for...of` or `Promise.all`.
- Independent `await`s in a loop that should be parallelized with `Promise.all`.
- `JSON.parse` without try/catch on untrusted input.
- Missing error handling in async functions called at top level.
- Date math done with raw millisecond numbers instead of a date library where timezones matter.
- `NaN` comparisons (`NaN === NaN` is false — use `Number.isNaN`).
- Object/array equality by reference when value comparison was intended.

## [security]
- `eval`, `Function()` constructor, or `setTimeout/setInterval` with string arguments.
- `child_process` with shell-interpolated strings (command injection).
- Unsanitized template literals in SQL queries or HTML output.
- `innerHTML` or `document.write` with user-controlled input.
- Prototype pollution via unchecked `Object.assign` or spread on user input.

## [data_integrity]
- Mutation of function parameters or shared module-level state.
- Shared mutable objects across async operations without defensive copying.
- Missing `structuredClone` or spread when passing objects that shouldn't be mutated.

## [api_contracts]
- Changed `module.exports` shape without updating consumers.
- Missing validation on public function inputs (trusting callers blindly).
- Callbacks with inconsistent error-first signatures.

## [maintainability]
- Deeply nested callbacks (>3 levels) — consider async/await or extraction.
- Large functions (>50 lines of dense logic) that should be decomposed.
