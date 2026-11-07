# Privacy and recording

The runtime processes agent hooks locally through a daemon bound to loopback by default.
It makes no model API calls. Raw hook payloads can contain sensitive source data even when
normalized output is redacted. Loopback is a local trust boundary, not a defense against
other processes running as the same user. Do not expose the daemon to an untrusted network.

Recordings are opt-in. Normal recording applies the rules in [Events: redaction](EVENTS.md).
Raw capture is a diagnostic option and must remain private. Default redaction is not a
promise that every project name or relative path is safe to publish; review every promoted
fixture and annotation. `fixtures-local/` and raw captures are ignored by Git.

Opening agent windows uses local process/terminal metadata. Native focus resolves a verified
host and can report partial or unavailable focus; it does not send a prompt to the agent.

Before sharing a recording, screenshot, or report, inspect it for identifying project names,
paths, session names, and secrets.
