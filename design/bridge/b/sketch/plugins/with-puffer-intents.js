// Config plugin: puts ios-intents/*.swift into the app target on every prebuild.
// Two mods with one job: withDangerousMod copies the files into ios/<project>/Intents/, withXcodeProject links
// them to the application target with IOSConfig.XcodeUtils.addBuildSourceFileToGroup (exported from
// @expo/config-plugins, verified in source). Dangerous mods run before other mods, so the files exist when the
// project mod runs. On SDK 56 this plugin is deleted and ios-intents/ becomes expo-app-intents' app-intents/.
const { withDangerousMod, withXcodeProject, IOSConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'ios-intents';
const GROUP = 'Intents';

/** @type {import('expo/config-plugins').ConfigPlugin} */
module.exports = function withPufferIntents(config) {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      // copy <projectRoot>/ios-intents/*.swift -> <platformProjectRoot>/<projectName>/Intents/
      throw new Error('not implemented');
    },
  ]);
  return withXcodeProject(config, async (config) => {
    // for each copied file: IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: `${projectName}/${GROUP}`, project: config.modResults })
    // idempotent: skip files already present in the group so repeated prebuild does not duplicate entries.
    throw new Error('not implemented');
  });
};

function swiftFiles(projectRoot) {
  throw new Error('not implemented');
}
