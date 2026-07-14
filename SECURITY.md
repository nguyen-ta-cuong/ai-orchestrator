# Security Policy

## Supported versions

Security fixes are provided for the latest published version. Before the first public npm release, fixes are made on the default branch.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue, pull request, discussion, or session transcript.

Use [GitHub private vulnerability reporting](https://github.com/nguyen-ta-cuong/ai-orchestrator/security/advisories/new) to report the issue. Include the affected version or commit, the impacted surface (Pi, MCP, Cursor installer, configuration, routing, lifecycle artifacts, or release packaging), reproduction steps, impact, and any suggested mitigation. Remove real credentials, private source, prompts, and user data from the report.

If private vulnerability reporting is unavailable, contact the repository owner through their [GitHub profile](https://github.com/nguyen-ta-cuong) to arrange a private channel. Do not open a public fallback report containing exploitable details.

The maintainer will acknowledge a complete report as availability permits, validate the impact, coordinate a fix and disclosure timeline, and credit the reporter unless anonymity is requested. Please allow time for a safe release before public disclosure.

## Security-sensitive areas

Reports are especially useful for credential or endpoint trust-boundary bypasses, prompt or tool-guard escapes, maker/checker separation failures, path traversal or symlink attacks, lifecycle lock/ownership races, unsafe Git or publication actions, secret leakage in evidence or logs, and MCP protocol or provider-response handling flaws.
