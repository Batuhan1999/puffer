// A file opened in Puffer from another app arrives as a file URL. Native imports it (ShareInbox in
// modules/puffer-native/ios/Folders.swift); there is no route for it, so a cold launch starts at the first screen.
// Requests are answered without review now, so an old request link opens Agents, where History shows it.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (path.startsWith('file:')) return initial ? '/' : null;
  if (/^(puffer:\/\/|\/)?request\//.test(path)) return '/agents';
  return path;
}
