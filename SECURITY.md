# Security policy

## Reporting a vulnerability

Email **niko@steelbrowser.com** with "steel-mcp-server security" in the subject. Please do not open a
public issue for a security report.

Include what you can: the version (`2.0.0` and later are supported), the tool call or request that
triggers it, what you expected, and what happened instead. A reproduction we can run ourselves is the
single most useful thing you can send.

You will get an acknowledgement within three working days and an assessment within ten. We will tell
you whether we are treating it as a vulnerability, and when a fix is expected. We are happy to
credit you in the release notes — tell us how you would like to be named, or that you would rather
not be.

## What this server treats as untrusted

Worth knowing before you report, because some of these are documented behaviour rather than bugs:

- **Web page content is untrusted by design.** Everything read from a page comes back inside an
  `<untrusted-page-content>` block, and the server strips hidden text and other common
  prompt-injection carriers. It cannot make an arbitrary website safe. A page that persuades a model
  to do something is a limitation of the mitigation, not a defect in it — but a page that escapes the
  fence itself is a vulnerability, and we want to hear about it.
- **Session handles are authorised per call.** A handle is usable only by the credential that minted
  it. A handle usable across credentials is a vulnerability.
- **Credentials are redacted before logging.** An API key, password, or bearer token reaching a log
  line, an error message, or a tool response is a vulnerability.
- **Every session has a hard timeout and an inactivity timeout.** A browser that outlives both, or
  one reachable without a session ID, is a vulnerability.

The threat model and the mitigations currently in place are written up in
[RESEARCH.md §7](RESEARCH.md#7-security).

## Scope

This policy covers the code in this repository. Steel's own platform — the API, the browsers it runs,
the dashboard — is covered by the disclosure process at [steel.dev](https://steel.dev). If you are
unsure which one you have found, send it to the address above and we will route it.
