# Jev, optional

Jev is the decision layer: which model a task goes to, and whether an action needs your OK. Without it, Desiide uses built-in rules that make the same kinds of calls.

Jev only ever gets **metadata**: file paths and sizes, languages, command names, your branch. It never gets file contents. Settings → Jev shows a live sample built from this workspace, and **Redact paths** hashes folder and file names first.

Jev can only make gating stricter, never looser.
