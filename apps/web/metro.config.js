// Metro configuration for a workspace package.
//
// Dependencies hoist to the monorepo root, so Metro has to be told to watch the
// root and to resolve modules from both node_modules directories. Without this
// the bundler resolves react-native from apps/web only and fails.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
