// https://docs.expo.dev/guides/using-eslint/
const { fixupConfigRules } = require('@eslint/compat');
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  ...fixupConfigRules(expoConfig),
  {
    ignores: ['dist/*'],
    settings: {
      'import/resolver': { typescript: { project: require.resolve('./tsconfig.json') } },
    },
  },
]);
