# Contributing to Hiddink Harness

Thank you for your interest in contributing to Hiddink Harness!

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
