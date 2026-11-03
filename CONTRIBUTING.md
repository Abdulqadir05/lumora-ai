# Contributing to Lumora AI

Thanks for considering a contribution. Changes should be focused, reviewable, and tested against the behavior they affect.

## Project layout

- `backend/` contains the Node.js/Express API, provider integrations, and `node:test` integration tests.
- `mobile/` contains the Expo/React Native app, Jest tests, distribution checks, and EAS configuration.
- `README.md` describes the current API and local setup. `DISTRIBUTION.md` covers private EAS builds.

## Before opening an issue or pull request

1. Search existing issues and pull requests for the same problem.
2. For a bug, include the app/backend version or commit, platform, steps to reproduce, expected behavior, actual behavior, and relevant redacted logs.
3. For a feature, explain the user problem and a concrete expected outcome. Discuss changes that add a provider, dependency, permission, paid service, or data collection before implementing them.
4. Never put secrets, personal data, private conversation contents, or production identifiers in an issue, test fixture, screenshot, or pull request.

## Local development

Use Node.js 22.17.0 for the mobile project. The backend supports Node.js 18.17 or later.

### Backend

```bash
cd backend
npm ci
npm test
```

Backend integration tests use local mock providers and are intended to run offline. To run the server locally, copy `.env.example` to `.env` and configure only local development values. Never commit `.env` or paste its contents into an issue or pull request.

### Mobile

```bash
cd mobile
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:distribution
```

`pnpm test:e2e` is optional and needs a separately running backend configured with the documented mock/test setup. Do not point tests at production services unless a maintainer explicitly asks you to.

## Change guidelines

- Preserve existing chat, SSE streaming, authentication, rate limits, model selection, search, weather, currency, and other tool behavior unless the issue specifically concerns it.
- Keep provider credentials on the backend. `EXPO_PUBLIC_*` values are embedded in app bundles and must not be treated as secrets.
- Do not weaken release guards, authentication, input validation, HTTPS checks, or quota/rate-limit protections to make a test pass.
- Use the existing provider and test mocks. Do not add a new paid provider or dependency without discussing the trade-offs in the issue first.
- Add focused regression tests for behavior changes. Keep tests deterministic and offline where practical.
- Avoid unrelated formatting or generated-file changes. Do not include APKs, build output, keystores, signing profiles, or local environment files.
- Update README/API documentation when a change alters user-visible or developer-facing behavior.

## Pull request checklist

- [ ] The change addresses one issue or has a clearly bounded scope.
- [ ] Tests were added or updated where appropriate.
- [ ] Backend: `npm test` passes for backend changes.
- [ ] Mobile: `pnpm typecheck`, `pnpm test`, and `pnpm test:distribution` pass for mobile/release changes.
- [ ] Documentation reflects any changed behavior.
- [ ] No secrets, personal data, generated builds, or unrelated files are included.
- [ ] Any manual/device-only verification and known limitations are stated in the PR description.

## Review and release

Opening a pull request does not authorize deployment, EAS builds, publishing, or changes to production credentials. Those actions require separate maintainer approval.
