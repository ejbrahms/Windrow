// @ts-check
//
// THE DASHBOARD'S LINTER. `npm run lint --prefix client`, and a job of its own in
// .github/workflows/ci.yml so a red rule is a release that does not happen.
//
// WHY THIS FILE EXISTS AT ALL, given `tsc -b` already runs in CI: the type-checker and the linter
// answer different questions. `tsc` asks "do the types line up"; it is entirely happy with a
// `useEffect` whose dependency array is missing the thing it closes over, an unused import, or a
// `catch (e) {}` that swallows a denial. Those are the mistakes that actually reach this codebase —
// a governance dashboard whose stale closure shows yesterday's grants is worse than one that does
// not compile, because only one of the two is visible.
//
// FLAT CONFIG, not .eslintrc. The previous `lint` script was deleted rather than repaired because
// it pointed at an eslintrc setup that no longer resolved under ESLint 9; this is the format ESLint
// 9 actually loads, so there is nothing left to drift.
//
// TYPE-AWARE RULES ARE DELIBERATELY OFF. `projectService` linting re-runs the whole TS program per
// lint and roughly triples the wall clock, to catch a class of bug `tsc -b` already catches in CI.
// The rules kept here are the ones the type-checker cannot see.

import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Build output and the linter's own dependencies are not source.
  { ignores: ["dist/**", "node_modules/**", "*.tsbuildinfo"] },

  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Fast Refresh only re-renders a module that exports components and nothing else. A page file
      // that also exports a helper silently falls back to a full reload — a warning, not an error,
      // because a few files here export a badge beside their page on purpose.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      // `_`-prefixed is the established way to say "bound on purpose, not read" — a destructured
      // rest that drops a field, a catch binding kept for its name. Everything else unused is dead.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // A swallowed error on this dashboard is a denial nobody was told about. If a catch really has
      // nothing to do, it says so with a comment and this rule allows it.
      "no-empty": ["error", { allowEmptyCatch: false }],

      // `==` against null is the one coercion this codebase relies on (null-or-undefined in one
      // check, which is how the API's nullable fields are read everywhere).
      eqeqeq: ["error", "always", { null: "ignore" }],

      // Debug leftovers. `console.warn`/`.error` stay — they are how the client reports a failed
      // fetch it could not otherwise surface.
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Sequential awaits are almost always a fan-out written as a queue. GrantsPage has the one
      // deliberate exception and says so with a disable comment — which this rule is what makes
      // meaningful, rather than a directive suppressing a rule nobody turned on.
      "no-await-in-loop": "error",
    },
  },

  // MODULES THAT EXIST TO BE SHARED. react-refresh/only-export-components is right about a *page*
  // that also exports a constant — that page silently loses Fast Refresh. It is wrong about these:
  // a context and its provider, a hook and the component it drives, and the two `shared.tsx` files
  // that are nothing but helpers. Splitting each into two files to satisfy a dev-server nicety
  // would scatter things that are read together. Scoped off here rather than disabled globally, so
  // a new page picking up a stray export still gets told.
  {
    files: [
      "src/hooks/**/*.tsx",
      "src/pages/**/shared.tsx",
      "src/components/Toast.tsx",
      "src/components/EventDrawer.tsx",
      "src/components/CapabilityFilters.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },

  // Vite's config runs in Node, not the browser, and is not part of the app's TS program.
  {
    files: ["vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },
);
