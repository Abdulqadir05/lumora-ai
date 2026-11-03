# Security policy

## Reporting a vulnerability

Please do not report exploitable security issues in public GitHub issues, discussions, or pull requests.

Use GitHub's **Report a vulnerability** flow for this repository (Security → Advisories → Report a vulnerability) so the report is private. If private vulnerability reporting is unavailable, contact the repository maintainer privately through their GitHub profile and ask for a secure reporting channel. Do not attach secrets or unredacted user data to a public issue.

Include, when safe:

- The affected component, file, endpoint, and commit or release.
- A concise description of the impact and conditions required to reproduce it.
- Minimal reproduction steps or a proof of concept that does not access another person's data, disrupt service, or incur provider charges.
- Suggested remediation, if known.

Do not include live API keys, bearer tokens, passwords, signing credentials, private certificates, production conversation contents, or other personal data. Redact logs and rotate any credential that may have been exposed.

## Scope and safe testing

The repository contains an Expo/React Native client and a Node.js/Express backend. A client token compiled into a mobile app can be extracted; it is not a per-user identity. Provider credentials belong only in the backend environment. Do not test against production systems or other users without explicit authorization.

Please allow the maintainer reasonable time to investigate and coordinate a fix before public disclosure. No response or remediation deadline is promised by this policy.

## Supported versions

Report issues against the current `main` branch or the latest build produced from it. Older builds may not receive security fixes.
