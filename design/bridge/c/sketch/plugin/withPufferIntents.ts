import { ConfigPlugin, IOSConfig, withDangerousMod, withInfoPlist, withXcodeProject } from 'expo/config-plugins';

// Runs during `npx expo prebuild`. ios/ stays generated; nothing is hand-edited.
//  1. withDangerousMod copies modules/puffer-core/app-intents/*.swift into ios/<App>/ (dangerous mods run first,
//     so the file exists before step 2 references it).
//  2. withXcodeProject adds each file to the app target with IOSConfig.XcodeUtils.addBuildSourceFileToGroup.
//  3. withInfoPlist adds NSAppTransportSecurity.NSAllowsLocalNetworking so ws://localhost works in Debug.
//     Later: UIBackgroundModes remote-notification and the aps-environment entitlement, behind option `push: true`
//     (needs a paid Apple Developer account).
// Idempotent: re-running prebuild overwrites the copy and skips files already in the project.
export type Options = { push?: boolean };
const withPufferIntents: ConfigPlugin<Options | void> = (config, options) => {
  throw new Error('not implemented');
};
export default withPufferIntents;
// app.json plugins gains: "./modules/puffer-core/plugin"
