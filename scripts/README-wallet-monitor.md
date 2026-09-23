# Independent staging wallet monitor

This Linux monitor runs the existing wallet health SELECT against **adbattle-test**
every five minutes using a **systemd user timer on your computer**. It does not
depend on Supabase cron, localhost:8000, the settlement worker, or Stripe.
It can therefore report a stopped settlement job or an unreachable Supabase API.
It never repairs accounts, invokes payment functions, or initiates transfers.

This is desktop staging monitoring, not an always-on hosted service. The computer
must be awake, online, and running the user's systemd session. Logout, shutdown,
sleep, a broken timer, or a broken desktop notification service can interrupt
coverage. A stopped monitor cannot alert about itself. `--status` identifies
missing observations or observations older than twelve minutes as `STALE`.
Use an independently supervised always-on host and an off-host heartbeat before
claiming continuous production monitoring. This PR does not set those up.

## Credentials and read-only scope

The only network endpoint is fixed in the runner:
`https://api.supabase.com/v1/projects/nccqnrcdygujulrnwair/database/query`.
The body includes `read_only: true` and the existing checked-in report SQL.
A SHA-256 pin prevents an unreviewed report edit from being sent. Updating the
report requires reviewing the SELECT, updating its pin, and running the tests.
There is no project/URL/query override. Redirects and environment HTTP proxies
are disabled; HTTPS certificate verification remains enabled. Requests time out
after 45 seconds; the systemd service has a 90-second overall limit.

Use a **Supabase Management API access token**, not a project publishable key,
service-role key, Stripe key, or database password. Create a dedicated expiring
token in [Supabase account access tokens](https://supabase.com/dashboard/account/tokens).
Where fine-grained token controls are available, restrict it to **adbattle-test**
and `database_read`. Do not grant extra access just to suppress an `INCOMPLETE`
result: review the missing access checks first.

A classic personal access token inherits the account's privileges; the
runner's read-only request does **not** reduce the token's permissions elsewhere.
Keep it on your own computer, never in this public repository, a browser script,
a screenshot, or chat. The setup prompt writes it only to
`~/.config/adbattle-wallet-monitor/access-token` (0600 inside a 0700 directory).
It is not placed in command arguments or printed. Expired/revoked/unreadable
credentials produce a monitor-error finding rather than a healthy result.

The report retains its original scope: database accounting, holds, settlement
queues, and cron SQL dispatch. A healthy report does not prove HTTP delivery,
current Stripe balance, transfer capability, or bank payout success.

## Install after the PR is merged

These commands assume your existing checkout is `/home/sportwhirl/AdBattle-staging`
on `wallet-ledger-90-10`. Keep local changes; if `git pull --ff-only` refuses,
resolve the checkout situation before proceeding.

```sh
cd /home/sportwhirl/AdBattle-staging
git pull --ff-only origin wallet-ledger-90-10
python3 scripts/monitor_wallet_health.py --configure
```

Paste the token into that **hidden local terminal prompt** and press Enter.
Configuration does not make a network call or start the timer. Python 3 and
`/usr/bin/notify-send` are required. On Arch, `notify-send` is supplied by
`libnotify`; a working desktop notification daemon is also needed.

Run the first check manually:

```sh
python3 scripts/monitor_wallet_health.py --notify-desktop
```

Expected for the completed staging fixture: `health: HEALTHY`, `problems: {}`,
and `pending_notifications: 0`. An initial healthy result intentionally sends
no alert. An initial problem sends one. Do not install the timer until this
query succeeds and desktop notifications work. If an API read is restricted,
the report can be `INCOMPLETE`; inspect the original report in SQL Editor as
postgres rather than changing wallet grants to make the monitor green.

Test the desktop separately with a harmless local notification:

```sh
/usr/bin/notify-send 'AdBattle monitor setup' 'Local notification test'
```

Then install the two user units; this does not require `sudo`:

```sh
mkdir -p ~/.config/systemd/user
install -m 644 scripts/systemd/adbattle-wallet-monitor.service ~/.config/systemd/user/
install -m 644 scripts/systemd/adbattle-wallet-monitor.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now adbattle-wallet-monitor.timer
systemctl --user list-timers adbattle-wallet-monitor.timer
```

The service's `%h/AdBattle-staging` path means `$HOME/AdBattle-staging`.
If your checkout has another path, edit the installed `ExecStart` to its absolute
path before enabling. The timer runs once shortly after session startup and
five minutes after each completed invocation. It does not catch up every missed
run after sleep, and it is independent of the database's every-minute cron job.
The included GitHub Actions job tests fixtures only; it does not schedule
production/staging API calls or store a Supabase credential.

## Status, history and notification behavior

```sh
python3 scripts/monitor_wallet_health.py --status
journalctl --user -u adbattle-wallet-monitor.service -n 20 --no-pager
systemctl --user status adbattle-wallet-monitor.timer
```

State lives in
`~/.local/state/adbattle-wallet-monitor/nccqnrcdygujulrnwair/state.json`.
It contains the latest sanitized observation, up to 288 observations (about a
day at five-minute intervals), and up to 100 transition events. Only fixed
check names, statuses, timestamps and local event IDs are stored. API bodies,
error text, wallet balances, owner IDs, and tokens are excluded. Files are
0600, directories 0700, and a file lock prevents overlapping local runs.
State is replaced atomically and synced before a notification is attempted.

- Repeated identical findings do not send another alert. Changing affected row
  counts alone does not send another alert.
- A new nonpassing check or changed severity sends an `UPDATED` alert.
- Returning from any problem to a valid fresh healthy report sends `RECOVERY`.
- Connection failures, rate limits, malformed/stale results, or credential
  problems are monitor errors, not evidence that the wallet itself is broken.
- Failed notifications remain queued, in order, and retry next run. Old queued
  transitions can be delivered after the underlying problem clears. At most
  three deliveries are attempted per run, keeping the invocation bounded.
- A successful `notify-send` means the desktop service accepted the request;
  it does not prove you saw it. A crash after delivery but before saving the
  delivery flag can cause one duplicate. Delivery is not exactly-once.
- If all 100 retained events are still pending, the runner stops with a visible
  local error instead of dropping them. Restore notification delivery before
  continuing; the next run can drain the existing outbox before adding an event.
  Preserve the state for review. Corrupt/unsafe state is never
  silently reset. Filesystem/configuration errors can prevent a desktop alert,
  so inspect the service journal and `--status` when coverage is uncertain.

Exit codes: `0` healthy with no queued notifications, `1` findings with delivered
notifications, `2` queued notifications (or stale offline status), `3` local
state/configuration failure or a concurrent run. `--status` returning `0` means
the observation is recent; inspect its `last.health` for wallet health.
The service accepts 1/2 as completed checks, and the timer runs again; those
codes are not a claim of wallet health or notification delivery.

To rotate the token, stop the timer, run `--configure` again, run one manual
check, then restart the timer. To stop monitoring:

```sh
systemctl --user disable --now adbattle-wallet-monitor.timer
systemctl --user stop adbattle-wallet-monitor.service
```

Revoke the dedicated token in Supabase when the monitor is retired. Keep any
incident history you need before removing its private files.

## Validation and source references

`python3 tests/wallet_monitor_test.py` exercises report validation, credentials,
fixed endpoint/read-only requests, redirect rejection, error redaction, stale
reports, state permissions/locking, bounded retention and failure/recovery
notification retries. No test contacts Supabase/Stripe or sends a notification.
`npm test` includes these checks and an actual SQL missing-schema report fixture.
Hosted API authentication, the desktop daemon and the installed timer require
the post-merge checks above; local tests do not claim those are complete.

References checked for this implementation:
- [Supabase query API](https://supabase.com/docs/reference/api/v1-run-a-query)
- [Management API authentication](https://supabase.com/docs/reference/api/introduction)
- [systemd timer documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)
