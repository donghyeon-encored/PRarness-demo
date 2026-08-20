# Demo issue: mixed-fraction ingredients scale incorrectly

Use this as the body of a GitHub issue. Add only the `bug` label: the API wording
routes initial triage to the configured platform maintainer, while the changed
component path can exercise reviewer selection separately.

## Problem

The recipe scaling API returns the wrong amount for ingredients written as a
mixed fraction. Scaling `1 1/2 cups` from 4 servings to 8 servings returns
`2 cups`, but it should return `3 cups`.

## Reproduction

1. Run `npm start`.
2. Open <http://localhost:3000> and keep the example recipe unchanged.
3. Change the target from 4 servings to 8 servings.
4. Select **Scale recipe**.

The same problem can be reproduced with the `curl` command in `README.md`.

## Expected result

The flour amount is `3 cups`.

## Actual result

The flour amount is `2 cups`.

## Scope

- Support a whole number followed by a simple fraction, such as `1 1/2`.
- Preserve existing support for numbers and decimal strings.
- Convert the TODO mixed-fraction test into a passing regression test.
- Reject malformed or zero-denominator fractions with a validation error.

This is demo data only. No security issue or personal data is involved.
