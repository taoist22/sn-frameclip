const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const exclusionList = require('metro-config/src/defaults/exclusionList');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    blockList: exclusionList([
      /android\/app\/build\/.*/,
      /android\/build\/.*/,
      /build\/.*/,
    ]),
  },
  maxWorkers: 2,
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
