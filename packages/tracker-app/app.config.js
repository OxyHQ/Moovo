// The static config lives in app.json; Expo passes it in as `config`.
module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    // Expo's oxc transformer, about 2x faster cold bundles than Babel. Development
    // only: in a production export it keeps the requires of dead platform branches
    // (`if (Platform.OS !== 'web') require(...)`), pulling native-only packages into
    // the web bundle. The CLI sets NODE_ENV before it reads this config.
    noxcturnalTransformWorker: process.env.NODE_ENV !== 'production',
  },
});
