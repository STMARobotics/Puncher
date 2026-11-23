# GitHub Copilot instructions

Follow [AGENTS.md](../AGENTS.md).

Puncher prioritizes zero cost when unused over availability and recoverability. Before adding or restoring an AWS or third-party service that may incur charges or has no free tier, stop and ask the user for confirmation. Explain the billing basis and offer the cheapest workable alternative.

Keep GitHub Actions minutes low. Avoid large matrices, duplicate validation, unnecessary browser runs, scheduled workflows, and extra hosted jobs. Keep verification in Actions, but favor a focused, cached check over comprehensive but redundant coverage.
