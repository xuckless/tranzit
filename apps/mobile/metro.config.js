const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow Metro to bundle .wasm files (required for expo-sqlite web support)
config.resolver.assetExts.push('wasm');

module.exports = config;
