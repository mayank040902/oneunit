# AGENT.md — AI Coding Agent Instructions

**Applies to:** All AI coding agents working in this repository.

## 1. Mandatory Rules

1. Read `AGENT.md` before starting any task.
2. Inspect the repository and relevant files before making assumptions or changes.
3. Understand the user's actual request before implementing anything.
4. Follow existing project conventions, established decisions, and repository instructions.
5. Never assume a feature, file, dependency, API, or configuration exists without verifying it.
6. Never invent requirements, behavior, test results, or implementation details.
7. Preserve existing functionality unless the task explicitly requires changing it.
8. Make the smallest complete change that solves the problem.
9. Avoid unrelated modifications, unnecessary refactoring, and speculative improvements.
10. Never overwrite or delete existing work without understanding its purpose and obtaining authorization when necessary.
11. Never disable tests, lint rules, type checks, or security checks to make a task pass.
12. Never claim work is complete without verifying the result.
13. Ask for clarification when an ambiguity materially affects correctness, safety, or scope.
14. Do not ask unnecessary questions when the repository and request provide enough information to proceed.
15. Do not publish, release, push, or perform destructive operations without explicit authorization.

## 2. Repository Inspection

Before modifying code:

1. Inspect the repository structure and working tree.
2. Check the relevant source files, tests, configuration, dependencies, documentation, and package scripts.
3. Read related implementations to understand existing behavior and dependencies.
4. Inspect Git changes when available to identify user modifications.
5. Identify the files that actually need to change.
6. Verify dependency APIs and installed versions using reliable sources when necessary.
7. Check for existing utilities or implementations before introducing new ones.

Do not inspect the entire repository indiscriminately. Focus on the files relevant to the task and expand the inspection when dependencies or side effects require it.

Never overwrite, revert, or discard unrelated user changes.

## 3. Task Planning

Before implementation:

1. Break the request into clear requirements and expected outcomes.
2. Identify the minimum changes needed to satisfy those requirements.
3. Determine which existing behaviors could be affected.
4. Identify relevant edge cases, failure conditions, and tests.
5. Establish how success will be verified.

Keep plans concise for simple tasks. Use a more detailed plan for complex tasks involving multiple packages, public APIs, migrations, or significant behavior changes.

Do not spend time planning work that is unnecessary for a small, unambiguous change.

## 4. Implementation Rules

1. Implement the requested functionality completely, not merely the visible happy path.
2. Follow existing naming, formatting, file organization, and coding conventions.
3. Prefer clear, maintainable, readable code over clever or unnecessarily abstract implementations.
4. Reuse existing utilities and abstractions when appropriate.
5. Avoid duplicated logic, dead code, unnecessary dependencies, and redundant configuration.
6. Handle errors, invalid inputs, asynchronous failures, and resource cleanup appropriately.
7. Use precise types and validate data at runtime wherever required.
8. Avoid unsafe casts, suppressed compiler errors, and weakened checks as workarounds.
9. Preserve backward compatibility unless a breaking change is explicitly required.
10. Update all affected call sites when changing an existing interface or implementation.
11. Do not introduce placeholder implementations, fake functionality, or misleading success responses.
12. Do not leave unfinished work, temporary debugging code, or unexplained workarounds.
13. Keep changes focused on the task.
14. Do not modify configuration or compiler settings merely to conceal implementation problems.
15. Do not add abstractions for hypothetical future requirements without a concrete need.

## 5. Dependency Management

Before adding, removing, or upgrading a dependency:

1. Establish why the change is necessary.
2. Check whether existing dependencies or built-in APIs already provide the required functionality.
3. Verify compatibility with the project's runtime, language version, module system, and package manager.
4. Inspect the dependency's actual public API and version.
5. Use the correct dependency category.
6. Update the appropriate lockfile through the project's package manager.
7. Avoid unrelated dependency upgrades.
8. Test the affected functionality after changing dependencies.

Never invent dependency APIs or assume that an API works identically across versions.

## 6. Testing and Verification

Every behavior change must have appropriate tests.

1. Add tests for new functionality.
2. Update existing tests when expected behavior changes.
3. Add regression tests for fixed defects where practical.
4. Test relevant success paths, edge cases, and failure conditions.
5. Prefer deterministic tests over timing-dependent tests.
6. Clean up resources created during tests.
7. Never weaken assertions or remove failing tests merely to obtain a passing result.
8. Never replace a necessary integration test with a mock that avoids testing the behavior in question.

Before reporting completion, run the relevant checks available in the repository:

- Focused tests.
- Relevant full test suite.
- Type checking.
- Linting.
- Production build.
- Integration tests when required.
- Packaging or runtime verification when relevant.

Use existing scripts and commands whenever possible.

If a check fails, investigate the cause. Fix issues introduced by the changes and distinguish pre-existing failures or environmental problems from new defects.

If a check cannot be run, state that explicitly. Never report an unexecuted check as successful.

## 7. Documentation and File Management

1. Update documentation when behavior, usage, configuration, or public interfaces change.
2. Keep examples consistent with the actual implementation.
3. Verify file paths and filenames before creating or modifying files.
4. Avoid creating duplicate documentation or redundant files.
5. Follow existing documentation conventions.
6. Remove temporary files created during the task when they are no longer needed.
7. Do not delete existing files simply because they appear unused; investigate their purpose first.
8. Do not claim documentation or examples were verified unless they were actually checked.

## 8. Working with Existing Changes

1. Respect modifications made by the user or other contributors.
2. Inspect the diff before modifying files that already contain uncommitted changes.
3. Do not revert unrelated changes.
4. Do not overwrite work from another process or agent without understanding its state.
5. Coordinate changes when multiple tasks or agents affect the same files.
6. Review the final diff for accidental deletions, unrelated edits, generated-file noise, and unintended changes.

## 9. Problem-Solving Behavior

When encountering an error:

1. Read the complete relevant error message.
2. Identify the underlying cause rather than treating only the symptom.
3. Inspect the related implementation, configuration, and dependency behavior.
4. Reproduce the problem when practical.
5. Apply the smallest reliable fix.
6. Add a regression test when appropriate.
7. Rerun the relevant checks.

Do not repeatedly apply speculative fixes without gathering evidence.

Do not hide errors, suppress warnings indiscriminately, or introduce workarounds that create additional problems.

When multiple solutions are possible, prefer the solution that best fits the existing codebase, satisfies the requirements, and minimizes unnecessary complexity.

## 10. Security and Safety

1. Never expose secrets, credentials, tokens, private keys, or sensitive user data.
2. Never commit secrets or include them in examples, logs, or generated artifacts.
3. Validate untrusted input and handle authorization correctly.
4. Avoid introducing vulnerabilities through unsafe input handling, dependency changes, or insecure defaults.
5. Do not execute untrusted scripts or destructive commands without appropriate inspection and authorization.
6. Avoid commands that can irreversibly delete data or discard user changes.
7. Review security implications whenever authentication, authorization, cryptography, networking, file access, or sensitive data handling is modified.
8. Never claim a system is secure based solely on passing tests.

## 11. Final Review

Before finishing any task:

1. Review the final diff.
2. Confirm that every requested requirement has been addressed.
3. Check for unintended changes, missing imports, unused code, and incomplete implementations.
4. Run the applicable verification commands.
5. Confirm that documentation and tests reflect the actual changes.
6. Identify any remaining limitations or unresolved issues.
7. Ensure that no unauthorized publishing, releasing, pushing, or destructive operation occurred.

Do not mark a task complete if essential requirements remain unfinished.

## 12. Final Response Requirements

After completing a task, provide a concise, factual report containing:

- **Implemented:** What was changed.
- **Files changed:** The relevant files and their purpose.
- **Verification:** Commands executed and their actual results.
- **Remaining issues:** Any incomplete work, failed checks, or limitations.

Adapt the report to the task size. For a small task, a few sentences are sufficient.

Do not repeat the entire implementation unless requested.

Do not claim success without evidence. Clearly distinguish verified facts from assumptions.

If no changes were necessary, explain why.

If the task could not be completed, state what prevented completion and what remains to be done.

## 13. Final Rule

**Understand first. Inspect before changing. Implement only what is needed. Verify before claiming success. Protect existing work. Report the truth.**