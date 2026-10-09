// modules/puffer-native/app.plugin.js (shown as TS for the types)
// Listed in app.json "plugins" as "./modules/puffer-native/app.plugin.js".
// Everything native that the app target needs and that is not a pod. Fails prebuild loudly when an
// anchor is missing instead of producing a build where intents silently do not exist.

import type { ConfigPlugin } from 'expo/config-plugins';
import { withInfoPlist, withXcodeProject } from 'expo/config-plugins';

/** Source of truth for the app-target sources. Referenced in place, never copied, so edits need no re-prebuild. */
export const APP_TARGET_SOURCES = ['app-target/PufferIntents.swift'] as const;

/** The only copy. PufferAppDelegate reads it back from Info.plist at launch. */
export const REFRESH_TASK_ID = 'dev.local.puffer.sync';

const withPuffer: ConfigPlugin = (config) => withAppTargetSources(withPufferInfoPlist(config));

/**
 * Info.plist:
 * - BGTaskSchedulerPermittedIdentifiers += REFRESH_TASK_ID
 * - UIBackgroundModes += "fetch" (belief: available to a free personal team)
 * - NSAppTransportSecurity.NSAllowsLocalNetworking = true, so http://localhost reaches the relay
 * No entitlements: App Intents and App Shortcuts need none (belief), and push is out of scope.
 */
export const withPufferInfoPlist: ConfigPlugin = (config) =>
  withInfoPlist(config, () => {
    throw new Error('not implemented');
  });

/**
 * Adds each APP_TARGET_SOURCES file to the main app target's Sources build phase as a reference
 * relative to the project (../modules/puffer-native/...). Idempotent: a second prebuild finds the
 * reference and adds nothing. Throws if the main target cannot be found.
 * Belief: IOSConfig.XcodeUtils.addBuildSourceFileToGroup or the xcode package's addSourceFile does this.
 */
export const withAppTargetSources: ConfigPlugin = (config) =>
  withXcodeProject(config, () => {
    throw new Error('not implemented');
  });

export default withPuffer;
