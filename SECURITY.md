# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the maintainer.
Do not open a public issue for sensitive security findings.

## Scope

Security-sensitive areas in this repository include:

- upstream URL parsing and allowlist checks
- authentication header handling
- request/response conversion logic
- streaming parser and resource cleanup paths

## Hardening Defaults

- upstream host allowlist enabled
- request timeout enabled
- strict JSON/request shape validation
