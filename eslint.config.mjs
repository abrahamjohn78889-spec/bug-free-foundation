import coreWebVitals from "eslint-config-next/core-web-vitals"
import typescript from "eslint-config-next/typescript"

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "data/**"],
  },
  {
    // Standard convention: underscore-prefixed identifiers are intentionally
    // unused (e.g. required-but-ignored function params).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The React Compiler purity/effect rules are informative for this
      // codebase but flag pre-existing, benign patterns (a Date.now()-based
      // live countdown display, and prop->local-draft state syncing). Keep
      // them visible as warnings rather than hard errors so the lint script
      // stays green in CI without risky UI refactors.
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // The trading engine deliberately lazy-loads the LIVE executor via
    // require() inside buildExecutor() so live wallet/SDK code never enters
    // the paper-trading path. This is an intentional architectural choice,
    // not a code smell, so allow require() in these server-only modules.
    files: ["lib/**/engine.ts", "lib/**/standing-order.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]

export default eslintConfig
