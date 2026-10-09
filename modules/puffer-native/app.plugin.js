/* global __dirname */
const fs = require('fs');
const path = require('path');
const { IOSConfig, withInfoPlist } = require('expo/config-plugins');

const APP_TARGET_DIR = path.join(__dirname, 'app-target');
const BACKGROUND_TASKS = { refresh: 'dev.local.puffer.sync', index: 'dev.local.puffer.index' };

const union = (list, ...values) => [...new Set([...(list ?? []), ...values])];

// What Puffer takes (FolderStore.kinds and ShareInbox in ios/Folders.swift): documents, and Markdown or a folder of it,
// which become notes. Alternate rank: offered in Open In and the share sheet, never the default app for these types.
const OPENABLE_TYPES = ['com.adobe.pdf', 'public.plain-text', 'net.daringfireball.markdown', 'public.folder'];
const MARKDOWN_TYPE = {
  UTTypeIdentifier: 'net.daringfireball.markdown',
  UTTypeDescription: 'Markdown document',
  UTTypeConformsTo: ['public.plain-text'],
  UTTypeTagSpecification: { 'public.filename-extension': ['md', 'markdown'], 'public.mime-type': ['text/markdown'] },
};

const withPufferInfoPlist = (config) =>
  withInfoPlist(config, (config) => {
    const plist = config.modResults;
    plist.PufferBackgroundTasks = BACKGROUND_TASKS;
    plist.BGTaskSchedulerPermittedIdentifiers = union(
      plist.BGTaskSchedulerPermittedIdentifiers,
      ...Object.values(BACKGROUND_TASKS),
    );
    plist.UIBackgroundModes = union(plist.UIBackgroundModes, 'fetch', 'processing');
    plist.NSAppTransportSecurity = { ...plist.NSAppTransportSecurity, NSAllowsLocalNetworking: true };
    plist.CFBundleDocumentTypes = [
      ...(plist.CFBundleDocumentTypes ?? []).filter((type) => type.CFBundleTypeName !== 'Puffer document'),
      { CFBundleTypeName: 'Puffer document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: OPENABLE_TYPES },
    ];
    // iOS copies an opened file into the app, which moves it to Shared with Puffer.
    plist.LSSupportsOpeningDocumentsInPlace = false;
    // Puffer no longer reads photos; an existing project still carries the strings expo-media-library wrote.
    delete plist.NSPhotoLibraryUsageDescription;
    delete plist.NSPhotoLibraryAddUsageDescription;
    // The note editor's Take Photo and Scan Documents. Choose Photo uses the system picker, which needs no permission.
    plist.NSCameraUsageDescription = 'Puffer uses the camera to add photos and scanned documents to your notes.';
    plist.UTImportedTypeDeclarations = [
      ...(plist.UTImportedTypeDeclarations ?? []).filter((type) => type.UTTypeIdentifier !== MARKDOWN_TYPE.UTTypeIdentifier),
      MARKDOWN_TYPE,
    ];
    return config;
  });

// App Intents metadata is extracted only from the app target, so these files are compiled there, not in the pod.
const withAppTargetSources = (config) => {
  const files = fs.readdirSync(APP_TARGET_DIR).filter((f) => f.endsWith('.swift'));
  if (files.length === 0) throw new Error(`puffer-native: no Swift sources in ${APP_TARGET_DIR}`);
  return files.reduce(
    (config, file) =>
      IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
        filePath: file,
        contents: fs.readFileSync(path.join(APP_TARGET_DIR, file), 'utf8'),
        overwrite: true,
      }),
    config,
  );
};

module.exports = (config) => withAppTargetSources(withPufferInfoPlist(config));
