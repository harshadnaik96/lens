# 🐍 Python Review — Lens Skill Pack

## [correctness]
- Mutable default arguments (`def f(x=[])`) — shared across all calls; use `None` and assign inside.
- `except Exception` or bare `except:` swallowing errors silently (no log, no re-raise).
- Catching a broad exception type when a specific one (`ValueError`, `KeyError`) is intended.
- `is` / `is not` used for value equality instead of `==` / `!=` (works by accident for small ints/interned strings).
- Floating-point equality with `==` instead of `math.isclose`.
- Generator exhausted and reused (generators are single-pass; assign to `list()` if iterated more than once).
- `dict.keys()` / `.values()` / `.items()` mutated during iteration.
- `+=` on an immutable (str, tuple) inside a loop — creates a new object each iteration; use a list and `''.join`.
- `threading.Thread` target called instead of passed (`target=fn()` vs `target=fn`).
- Late binding in closures: lambda/function in a loop captures the loop variable by reference, not by value.
- `os.path.join` used with an absolute second argument silently discards the first.

## [security]
- `eval()` / `exec()` on any input that is not a compile-time literal.
- `subprocess.shell=True` with string interpolation (command injection).
- `pickle.loads` / `yaml.load` (not `safe_load`) on untrusted data — arbitrary code execution.
- SQL string formatting via `%` or `.format()` — use parameterized queries (`?` / `%s`).
- `os.system` with user-controlled input.
- `tempfile.mktemp()` (deprecated; use `mkstemp` / `NamedTemporaryFile`) — TOCTOU race.
- Hardcoded secrets or tokens in source.
- `hashlib.md5` / `hashlib.sha1` for password hashing — use `bcrypt`, `argon2`, or `hashlib.scrypt`.
- Flask/Django: `DEBUG=True` or `SECRET_KEY` set to a literal in production config.

## [data_integrity]
- Missing `with` block on file opens, DB connections, or locks (resource leak if exception raised).
- `threading.Lock` / `RLock` not held across a read-modify-write sequence (TOCTOU).
- Shared mutable state between threads without a lock or queue.
- `asyncio` coroutines that block on synchronous I/O (`requests`, `time.sleep`) — stalls the event loop; use `httpx`/`aiohttp` and `asyncio.sleep`.
- `asyncio.gather` without error handling — one failure silently cancels siblings when `return_exceptions=False`.
- Django/SQLAlchemy: missing transaction boundary around multi-step writes that must be atomic.
- `global` keyword mutating module-level state from multiple callers.

## [api_contracts]
- Public function with no type annotations (PEP 484) on parameters or return type.
- `Any` used in an annotation where a narrower type is clearly possible.
- Returning `None` implicitly when the declared return type is non-optional.
- Raising a generic `Exception` from a public API instead of a domain-specific subclass.
- Positional-only args in a public API that would break callers if renamed.
- `**kwargs` on a public function where an explicit signature is feasible.
- Missing `__all__` in a module intended as a library (leaks private names).

## [maintainability]
- `pylint`/`flake8`/`ruff`-fixable style issues are NOT worth commenting on.
- Deeply nested `if`/`for` blocks (>3 levels) that could be flattened with early returns or helper functions.
- Large functions doing multiple unrelated things (split signal, not style).
- Magic numbers/strings that should be named constants.
