# Security

Never publish secrets in issues, pull requests, screenshots or support logs. Report reproducible security problems through GitHub private vulnerability reporting where available; otherwise ask the maintainer for a private reporting channel without disclosing the vulnerability in public.

Use device-protected storage for ChatGPT credentials. Sony credentials belong in a separately protected backend vault. No shared tokens, request proxies for other users, insecure TLS overrides or publicly exposed databases.

This is early software, not an audited multi-user service. The maintained cloud remains owner-only. Secret exclusion is checked for each publication; a public-source release does not include the private development repository's history.
