## Review checklist

In order of importance:
1. Does the change do what the plan and acceptance criteria say, including the unhappy paths?
2. Error handling: are failures surfaced, not swallowed?
3. Security: untrusted input, secrets, file paths, shell commands, injection.
4. Concurrency, ordering and data integrity, where relevant.
5. Fit with the codebase: conventions, naming, layering.
6. Tests: do they fail without the change, and do they check behaviour rather than implementation?
7. Scope: anything in the diff that the task did not ask for.

Skip style preferences that a linter would catch.
