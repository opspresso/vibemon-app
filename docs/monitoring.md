# Cloud monitoring

Open **Monitoring…** from the tray menu. Enter the Web origin and a generated read token, then select **Save and connect**. Create the token in the Web site's `/account` page with Google login. A write-only token cannot display data.

The read token is encrypted with Electron `safeStorage`, backed by the operating system keychain or secret service. No plaintext read token is returned to the renderer or written to preferences. Linux `basic_text` storage is rejected. Unlock or configure your OS secure storage if the app cannot save the token. To remove it, select **Disconnect**.

Select the sources and metrics to display under **Connection and display settings**. **Discover sources** refreshes the available source list. Latest state is polled every 30 seconds, restricted to the selected sources. **View recent hour** loads minute aggregates and refreshes them every minute until the panel closes. No trend requests run while the panel is closed or the window is hidden.

Host cards display CPU, memory, GPU, and temperature. Spark uses **Unified memory**. Cluster cards display CPU, memory, ready/total nodes, and unhealthy pods. Agent cards preserve character and state information; fresh selected agent observations also enter the existing character-window routing path under cloud-specific IDs, keeping local hook projects separate.

- **Unavailable**: metric not supported, absent, or failed; it is never substituted with zero.
- **Stale**: no accepted server receipt for 120 seconds; values are the last known observation.
- **Token expired or revoked**: supply a current read token.
- **Permission denied**: use a token with `read` permission.
- **Cannot reach Web**: retained values remain visible and become stale as time passes.
- **No data yet**: connected account has no observations.

Chart gaps mean no recorded sample. Unchanged heartbeat messages refresh status but add no chart sample. A single observed minute appears as a point. The Web retains visible trends for 24 hours; this app requests only the recent hour.

The existing localhost hook endpoint and character/bubble behavior remain available without cloud configuration. HTTPS is required for cloud origins. An unpackaged development app also accepts loopback HTTP for isolated tests.

## Verification

`pnpm exec jest tests/monitoring.test.js --runInBand` verifies polling, selection, permissions, stale/offline recovery, late responses, and encrypted storage boundaries. `tests/native/monitoring-smoke.cjs` uses an isolated Web fixture to verify native Electron rendering and the actual OS encryption provider. Set `VIBEMON_TEST_FIXTURE` to the private fixture JSON emitted by Web's `scripts/local-monitoring-fixture.ts`; the native test never prints credentials.

![Spark gauges](images/monitoring-spark.png)

![Spark trend](images/monitoring-spark-trend.png)
