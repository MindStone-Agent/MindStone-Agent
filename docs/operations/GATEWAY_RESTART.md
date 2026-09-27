# Restarting the gateway from the Console

Saving some settings (a connector, the gateway's host or port) returns
`restartRequired`. The Console can restart the gateway itself only when
something outside the gateway will start it again. That something, the
supervisor, is **declared** by whatever starts the gateway, and checked
against evidence; it is never guessed (#90).

## Declaring the supervisor

Set `MINDSTONE_AGENT_SUPERVISOR` in the gateway's environment:

| Value | Set by | Evidence the gateway checks | What restart does |
|---|---|---|---|
| `launchd` | `mindstone gateway install` (the plist sets it) | `XPC_SERVICE_NAME` is set and the parent is launchd (pid 1) | exits with 75; `KeepAlive` starts it again. launchd waits up to `ThrottleInterval` (10 s by default) if the process lived less than that |
| `managed` | `mindstone gateway start` | the managed PID file names this process | a detached helper waits for the exit, starts the gateway again with the same environment and log, and rewrites the PID file. Its progress is in `<dataDir>/gateway/restart.json`, which `mindstone gateway status` shows |
| `systemd` | your unit file | `INVOCATION_ID`, `JOURNAL_STREAM` or `NOTIFY_SOCKET` is set | exits with 75. Use `Restart=always`, or `Restart=on-failure` (75 is a failure), or `RestartForceExitStatus=75` |
| `docker` | your compose file or `docker run` | `/.dockerenv` exists | exits with 75. Use `restart: unless-stopped` or `always`, or `on-failure` |

Unset, or declared without the evidence (a stale or copied declaration),
means the Console can't restart the gateway: `POST /admin/restart` answers
`409` with what to run on the host, and nothing exits.

The repo's `docker-compose.yml` runs the interactive Pi container, not the
gateway, so it declares nothing. A compose file that runs the gateway should
set both `MINDSTONE_AGENT_SUPERVISOR: docker` and a restart policy.

## What a restart does

1. `POST /admin/restart` answers `202` first, then the gateway shuts down the
   usual way (stops listening, stops the connectors, lets in-flight work
   finish), capped at 10 s, and exits with 75.
2. At most one restart is under way at a time, and at most 5 are accepted
   in 10 minutes (`429` after that), so a restart loop from a bad config
   can't be driven from the browser.
3. `GET /admin/status` shows `supervisor`, `supervisorConfirmed`,
   `supervisorDetail`, `startedAt` (a new value means it came back) and
   `recentStarts` (gateway starts in the last 10 minutes; several without a
   restart asked for is a crash loop).

Starting a stopped gateway, `gateway stop` and service install stay on the
host.
