# Pre-publish review

Code review of the extension ahead of publishing to the VS Code Marketplace, with required changes, suggested improvements, and the publishing steps. Nothing in this document has been implemented yet.

## Must fix before publishing

1. **Remote workspaces.** There is no `extensionKind`, so under Remote SSH, WSL or Codespaces the extension runs on the remote host. The `chatSessions` watch, which is derived from `globalStorageUri`, then points at the wrong machine. Add `"extensionKind": ["ui"]`.
2. **Forced status bar position.** Priority `100001` grabs the far left of the right-hand status bar group for every user. Use a normal priority, and optionally add alignment and priority settings.
3. **UK-only bank holidays.** Bank holidays always come from gov.uk and cannot be turned off. Add a `none` option and make it the default, or support other countries. Make the weekend days configurable.
4. **Hard-coded locale.** Number formatting (`fmt`) and the calendar use `'en-GB'`, and weeks always start on Monday. Use the user's locale.
5. **`githubScopes` setting.** Users can break sign-in with this setting. Hard-code the scope and remove the setting.
6. **No `fetch` timeout.** A hung request leaves `busy = true` and blocks every later refresh. Add `signal: AbortSignal.timeout(15_000)`.
7. **No 401/403 handling.** A revoked or expired token shows a generic warning. Switch the bar to the sign-in prompt instead.
8. **Unlimited or unsupported plans.** When there is no limited premium snapshot, the bars show an error. Hide them or show "Unlimited" instead.
9. **Stale tooltip text.** The daily tooltip says "usage before VS Code started is not counted". That has not been true since the baseline started using the previous day's last reading.

## Correctness improvements

10. **Month end and quota reset date.** `workingDaysLeft` counts to the end of the calendar month. It should count to the day before `quota_reset_date`. This account resets on the 1st; personal plans may reset on another day, which is not yet verified.
11. **Weekend usage counted against Monday.** The baseline uses the last reading from any earlier date, so usage between Friday's last reading and Monday's first lands on Monday. This is probably acceptable, but document it in the README or tooltip.
12. **Multiple windows.** Each VS Code window runs its own instance: separate polling, a separate watcher, and separate `globalState` writes. N windows means N API calls per interval. Coordinate between windows, for example by polling only from the focused window or sharing the last fetch time through `globalState`.
13. **Chat activity watch.** It watches all of `workspaceStorage` recursively. Other extensions write there constantly, recursive watches on Linux use inotify handles, and it depends on an undocumented VS Code storage layout. Make it a setting that is off by default, or remove it now that the scheduled poll covers the gap.
14. **`refreshMinutes` needs a reload.** Restart the interval when the setting changes.
15. **Duplicate focus cooldown.** The `> 60_000` check in `onDidChangeWindowState` repeats `MIN_REFRESH_MS`. Remove it.
16. **Setting scope.** Pruning and calendar toggles write only to user (Global) settings, so `extraDaysOff` entries in workspace settings are never pruned. Mark `extraDaysOff` and `bankHolidayRegion` as `"scope": "application"`.
17. **Noisy log.** The full quota snapshot is logged on every poll, indefinitely. Use `createOutputChannel(name, { log: true })` and log the snapshot at debug level.

## Code quality

18. **Tests.** Move the pure helpers (`workingDaysLeft`, `expandEntry`, the range merging in `toggleDay`, `bar`, `pastel`) into their own module and unit test them with `node --test`. The range merging and the month-end and reset-date edge cases carry the most risk.
19. **`refresh()` length.** At about 100 lines, it should be split into fetch, compute, baseline and render steps.
20. **Command titles.** Use the `"category": "Copilot Usage Bars"` field instead of prefixing every title.
21. **Webview.** The CSP, nonce and message validation are good. Also add `localResourceRoots: []`.

## Marketplace risks

- **Undocumented endpoint.** `copilot_internal/user` is internal to GitHub and could change or be blocked at any time. Say so in the README and fail gracefully.
- **Token use.** The extension sends the user's GitHub token to `api.github.com`. That is legitimate, but the README should state it plainly.
- **Name and trademark.** "Copilot" is a GitHub/Microsoft trademark. A name like "Usage Pacer for Copilot", with "for" before the trademark, is the safer pattern. Marketplace policy on this has not been checked, so read the publisher agreement.
- **Employer policy.** Check whether your employer has an IP or open-source policy that applies before publishing under your name.

## Manifest and packaging gaps

- `publisher` must be a real Marketplace publisher ID, not `local`.
- Add `README.md`, `CHANGELOG.md`, `LICENSE` and an `icon` (128×128 PNG).
- Add `repository`, `categories` (for example `["Other"]`), `keywords`, and optionally `galleryBanner`.
- Add `"capabilities": { "untrustedWorkspaces": { "supported": true }, "virtualWorkspaces": true }`.
- Add a `.vscodeignore` so development files are left out of the package.
- Bump `version` before each publish.

## Publishing steps

1. **Microsoft account and Azure DevOps.** Sign in at dev.azure.com and create an organisation if you do not have one.
2. **Personal access token.** Create one in Azure DevOps (User settings → Personal access tokens). Set organisation to "All accessible organizations" and scope to Marketplace → Manage. Microsoft has been tightening PAT rules, so check the current `vsce` documentation if this step has changed.
3. **Publisher.** Create one at `https://marketplace.visualstudio.com/manage/createpublisher` and put its ID in `package.json`.
4. **Install `vsce`.** Run `npm i -g @vscode/vsce`.
5. **Package and test.** Run `vsce package`, then `code --install-extension copilot-usage-bars-x.y.z.vsix`. Remove the development junction in `~/.vscode/extensions` first, so that you are testing the packaged build.
6. **Log in.** Run `vsce login <publisher>` and paste the token.
7. **Publish.** Run `vsce publish`, or `vsce publish patch` to bump the version and publish in one step.
8. **Optional: Open VSX.** This reaches VSCodium and Cursor users. Create an account at open-vsx.org, get a token, then run `npx ovsx publish -p <token>`.
9. **Optional: verify your domain** on the publisher page to get the verified badge.
