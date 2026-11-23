# Claude instructions

Read and follow [AGENTS.md](AGENTS.md). For Puncher, low idle cost is the top operational priority.

Stop and ask the user before proposing or adding a service that is expensive, may incur ongoing charges, or has no free tier. Include a cost estimate and lower-cost alternative. Never silently re-enable PITR, CloudWatch alarms/SNS, detailed API metrics, queues/DLQs, EventBridge archives, provisioned databases, NAT/VPC services, WAF, or paid external services.

Keep GitHub Actions small: no bloated matrices or duplicate workflows. Prefer one focused validation path and cached dependencies. Verification should happen in Actions, but minimize minutes. Run browser/database suites only when code changes require them.
