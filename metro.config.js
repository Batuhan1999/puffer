const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// relay/ is a separate Node package and design/ holds sketches; neither is part of the app bundle.
const existing = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  new RegExp(`^${path.join(__dirname, 'relay')}/.*`),
  new RegExp(`^${path.join(__dirname, 'design')}/.*`),
];

module.exports = config;
