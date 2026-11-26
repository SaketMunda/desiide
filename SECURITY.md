# Security policy

Desiide runs on your machine, reads your code and can run commands, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately on GitHub: go to the repo's **Security** tab and click **Report a vulnerability**.

Include what you found, how to reproduce it, and which version or commit you tested. You'll get a reply within 3 days. We'll keep you updated while we fix it and credit you in the release notes, unless you'd rather stay anonymous.

## What counts

Especially:

- A way for a model, a file in the workspace, or an extension to run a command without passing the policy gate, or to get past the deny-list.
- Any request to an endpoint the user didn't configure, or anything that sends file contents to Jev.
- API keys leaving VS Code SecretStorage: in logs, files, environment variables or network traffic.
- The orchestrator writing to disk directly instead of returning edits for approval.
- Problems in our build or release pipeline (GitHub Actions, the VSCodium fork patches, release artifacts).

Bugs in upstream VS Code or VSCodium belong with those projects, unless Desiide's patches make them worse.

## Supported versions

Desiide is in alpha. Only the newest pre-release on [GitHub Releases](https://github.com/SaketMunda/desiide/releases) gets fixes.
