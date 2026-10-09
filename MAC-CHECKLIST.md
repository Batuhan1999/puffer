# Mac validation checklist

Everything below was written in a cloud container without Xcode. The JS/TS side and the relay were typechecked, linted
and tested there; every Swift change is marked `// Unverified (cloud): validate on the Mac` (42 spots:
`grep -rn "Unverified (cloud)" modules/`). Remove a marker once its spot builds and behaves.

## 1. Build

- [ ] `git pull`, `npm ci`, `cd relay && npm ci` (Node 24 for the relay and the Node checks).
- [ ] New native modules (expo-secure-store, expo-web-browser, expo-network): `npx expo prebuild --clean`, then a dev build.
- [ ] Fix compile errors first in the spots the agents flagged: the optional enum patterns in `Bridge.target(of:)` and
      storing a bare `String` in `DocumentTable.put` (Notes.swift `bases` table).
- [ ] `scripts/editor-markdown-check/run.sh`: native parser checks, then Tiptap vs native byte for byte. The Body-first-line
      rule changed in both `markdown.ts` and `NoteDocument.swift`; a mismatch shows here.

## 2. Relay (local first)

- [ ] `cd relay && npm run typecheck && npm run e2e && npm run e2e:auth` (cloud: 116/0 and 23/0).
- [ ] `npm run relay`, point the app at it, create an account in the app (Agents > Account > Sign In), check the phone
      registers and syncs.

## 3. Simulator pass, light and dark, per editor

Run each with `EXPO_PUBLIC_PUFFER_EDITOR=native` (default), `tiptap`, `enriched`:
- [ ] Open, type, title/heading/body, lists and checklists (nested), table, colored highlights, note link (`>>`), #tags,
      attachments (photo, scan, file, drawing), fold a heading (Tiptap), dark mode.
- [ ] Set the first line to Body, leave and reopen: it stays Body.
- [ ] Notes list previews show no `*`, `_`, `<u>`, `==`.
- [ ] Delete a note with an attachment, empty Recently Deleted: `Documents/NoteAttachments/<id>` is gone.
- [ ] enriched only: open `puffer:///notes/enriched/roundtrip` over real notes and note the lossy count.
- [ ] Decide the editor (design/EDITOR-DECISION.md recommends native, Tiptap as fallback).

## 4. iPhone install

```sh
npx expo prebuild --clean
xcodebuild -workspace ios/*.xcworkspace -scheme Puffer -configuration Release \
  -destination id=00008110-0012183C3E7B801E DEVELOPMENT_TEAM=6Z8WY4U8PP -allowProvisioningUpdates
```
(Adjust the scheme name to the generated one; install with Xcode or `xcrun devicectl device install app`.)
- [ ] Sign in, agents connect, ask/answer works.
- [ ] Offline queue: airplane mode on the phone, have an agent create, append, update and delete notes (each answers
      `queued`), edit one of those notes on the phone meanwhile, go back online: writes apply in order, the update merges
      with your edit, History rows read "Written while offline".
- [ ] Account: Reset Relay Key (agents keep working), Delete My Data on Relay (phone unpaired; sign out and in to register
      again), Sign Out (phone stays registered).
- [ ] Background: start indexing, send the app to the background, watch the log for "indexing paused: app in background,
      model on the GPU", return: it continues. Known gap: the overnight index task cannot use the GPU, so it makes no
      progress with the model on the GPU; it needs its own CPU engine.

## 5. Apple Notes import

- [ ] In the user's Shortcut, re-add the "Sync Notes to Puffer" action after Find Notes (it accepts text and rich text),
      run it, check notes, folders and the import report (TESTING.md).

## 6. Relay deploy (when ready)

- [ ] `fly secrets set BETTER_AUTH_SECRET=$(openssl rand -base64 32)` (the relay refuses to start in production without it).
- [ ] Deploy, sign up with your own account first, then `fly secrets set PUFFER_ADMIN_EMAILS=<you>` (sign-up does not
      verify email, so whoever registers a listed address first becomes admin).
- [ ] Optional Sign in with Apple: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`,
      `APPLE_APP_BUNDLE_IDENTIFIER=dev.local.puffer`; return URL `https://puffer.fly.dev/api/auth/callback/apple`; restart at
      least every 180 days. The app has no Apple button yet (needs expo-apple-authentication).
- [ ] Before more users: encrypt queued writes with a phone public key (TODO in relay/src/protocol.ts), and add email
      verification to sign-up.

## 7. Housekeeping

- [ ] Delete the remote branch `wip/offline-queue` (a snapshot; everything is on main). The cloud proxy refused the delete.
- [ ] Check the react-native-enriched-html upstream issues (tables, highlights, nested lists); the cloud session could not.
