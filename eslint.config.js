/**
 * SARdine ESLint config — enforces S290 R1: `src/*` cannot import from
 * `app/*`. Kept intentionally minimal: one rule, one file glob. Extend
 * with care — rules that gate PRs should be reviewed with the team.
 */

// No-op stub for `react-hooks/exhaustive-deps` disable-directives left over
// from a previous config. The real plugin isn't wired — R1 is the only rule
// that gates commits here — but ESLint errors on unknown-rule directives by
// default, so we register the rule name as a no-op to keep those comments
// inert rather than ripping them out of working code.
const reactHooksStub = {
  rules: {
    'exhaustive-deps': { meta: { type: 'suggestion' }, create: () => ({}) },
  },
};

export default [
  {
    files: ['src/**/*.{js,jsx,mjs}'],
    plugins: {
      'react-hooks': reactHooksStub,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../app/*', '../../app/*', 'app/*', '@app/*'],
              message:
                'S290 R1: src/ cannot import from app/. Move the shared piece into src/ or invert the dependency.',
            },
          ],
        },
      ],
    },
  },
];
