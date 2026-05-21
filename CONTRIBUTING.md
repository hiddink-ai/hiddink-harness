# Contributing to Hiddink Harness

Thank you for your interest in contributing to Hiddink Harness!

## Branching Strategy

| Branch | Purpose |
|--------|---------|
| `release` | Release trunk (protected, npm publish base) |
| `develop` | Development trunk (GitHub default) |
| `feature/<topic>` | New features — branched from develop |
| `fix/<issue>` | Bug fixes — branched from develop |
| `docs/<topic>` | Documentation — branched from develop |

Workflow:

1. Branch from `develop`: `git checkout develop && git pull && git checkout -b feature/your-topic`
2. Commit using Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`)
3. Open a PR targeting `develop`
4. On release cut, a maintainer opens a `develop → release` PR
5. After merge into `release`, a `v<semver>` tag is pushed → `release.yml` CI publishes to npm

Never push directly to `release`. All changes flow through `develop`.

## Release Process

When preparing a release, follow the standard branching and tagging guidelines.

For normal releases, once you merge a release branch into `develop`, the `auto-tag` workflow automatically extracts the version from `package.json`, creates the annotated git tag, and pushes it to the repository to trigger downstream deployment workflows.

### #### Hotfix Process

For urgent production hotfixes, things are slightly different. 
Because hotfix branches are typically merged directly into main or custom release targets rather than release branches flowing into develop, the `auto-tag` will NOT trigger automatically.

In these cases, you must perform the tag creation and push manually:

1. Create the tag locally:
   ```bash
   git tag vx.y.(z+1)
   ```
2. Push the tag to origin:
   ```bash
   git push origin vx.y.(z+1)
   ```

This manual process ensures the patch version is correctly deployed without interfering with the develop pipeline.
