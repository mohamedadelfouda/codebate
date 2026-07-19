const sharedGlobals = {
  AbortController: "readonly", AbortSignal: "readonly", Buffer: "readonly", console: "readonly", crypto: "readonly",
  fetch: "readonly", FormData: "readonly", Headers: "readonly", performance: "readonly",
  process: "readonly", queueMicrotask: "readonly", Request: "readonly", Response: "readonly",
  setImmediate: "readonly", setInterval: "readonly", setTimeout: "readonly", clearInterval: "readonly", clearTimeout: "readonly",
  structuredClone: "readonly", URL: "readonly", URLSearchParams: "readonly", WebSocket: "readonly",
};

export default [
  {
    files: ["server/**/*.js", "public/**/*.js", "scripts/**/*.mjs", "test/**/*.{js,mjs}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: sharedGlobals },
    rules: {
      "constructor-super": "error", "for-direction": "error", "getter-return": "error",
      "no-async-promise-executor": "error", "no-class-assign": "error", "no-compare-neg-zero": "error",
      "no-const-assign": "error", "no-constant-binary-expression": "error", "no-dupe-args": "error",
      "no-dupe-class-members": "error", "no-dupe-else-if": "error", "no-dupe-keys": "error",
      "no-func-assign": "error", "no-import-assign": "error", "no-loss-of-precision": "error",
      "no-new-native-nonconstructor": "error", "no-obj-calls": "error",
      "no-self-assign": "error", "no-setter-return": "error", "no-shadow-restricted-names": "error",
      "no-sparse-arrays": "error", "no-this-before-super": "error", "no-undef": "error",
      "no-unexpected-multiline": "error", "no-unreachable": "error", "no-unreachable-loop": "error",
      "no-unsafe-finally": "error", "no-unsafe-negation": "error", "no-unsafe-optional-chaining": "error",
      "no-unused-labels": "error", "no-useless-assignment": "error", "no-useless-backreference": "error",
      "no-useless-catch": "error", "no-with": "error",
      "require-yield": "error", "use-isnan": "error", "valid-typeof": "error",
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest", sourceType: "module",
      globals: {
        ...sharedGlobals, alert: "readonly", confirm: "readonly", document: "readonly", EventSource: "readonly",
        FileReader: "readonly", getComputedStyle: "readonly", history: "readonly", localStorage: "readonly", location: "readonly",
        HTMLElement: "readonly", navigator: "readonly", requestAnimationFrame: "readonly", window: "readonly",
      },
    },
  },
];
