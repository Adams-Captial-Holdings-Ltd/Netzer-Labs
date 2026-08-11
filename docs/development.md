# Development from Any Computer

> **Setting up a local environment to actually run Netzer OS?** See
> [development.md](../development.md) in the repository root. That document is
> the canonical source of truth for the local development environment: the Floci
> AWS emulator, environment variables, ports, seeding, resetting, feature
> testing and AWS isolation.
>
> This page covers only the Git workflow for moving work between computers.

> You do not need a paid cloud development environment to work on Netzar OS.
> Clone the GitHub repository on any authorized Windows/WSL, macOS, or Linux
> computer, use the same locked dependencies and checks, and push your feature
> branch before changing devices. GitHub remains the source of truth and keeps
> the automatic development-to-QA path consistent.

## What You Need

- Access to the private GitHub repository
- Git
- Node.js 20 or newer
- Docker for the local AWS emulator, integration tests, and local image builds
- No AWS credentials for ordinary coding, unit tests, typecheck, or synth

GitHub Codespaces is optional and may have a separate cost. It is not required
by this workflow.

## First-Time Setup on a Computer

```bash
git clone https://github.com/emmanuelmadams4-lgtm/Netzer-Labs.git
cd Netzer-Labs
git switch development
npm ci --ignore-scripts
npm ci --prefix web --ignore-scripts
npm run typecheck
npm test
```

Do not copy `.env`, AWS credentials, dashboard tokens, signing keys, or client
data between computers. Configure only the local, nonproduction values required
for the task.

## Start New Work

```bash
git switch development
git pull --ff-only origin development
git switch -c feature/short-description
```

Use `fix/short-description` for a normal fix and `chore/short-description` for
maintenance. Production hotfixes follow the separate process in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Continue on Another Computer

Push the branch from the first computer:

```bash
git push -u origin feature/short-description
```

On the next authorized computer, clone the repository if needed, then run:

```bash
git fetch origin
git switch feature/short-description
npm ci --ignore-scripts
npm ci --prefix web --ignore-scripts
```

Commit or stash intentional local changes before switching devices. Never use a
force push to move work between computers.

## Validate Before a Pull Request

```bash
npm run typecheck
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm test
```

When Docker is available, also run the integration suite:

```bash
npm run test:integration:all
```

If you are already running the local development stack, use
`npm run local:test:integration` instead. `test:integration:all` starts
LocalStack on port 4566, which collides with the Floci emulator. See
[development.md](../development.md).

Push the branch and open a pull request into `development`. GitHub Actions
repeats the required checks. A failed check blocks the merge and prevents the
automatic QA deployment.

## What Happens After Merge

1. GitHub validates the `development` commit.
2. A green run uses short-lived GitHub OIDC credentials.
3. The Netzer lifecycle deploys the exact commit to the persistent T0 QA
   environment.
4. QA verification must pass before manual promotion begins.
5. Approved code moves through `development -> qa -> staging -> production` by
   pull request.

See [deployment.md](./deployment.md) for promotion, signed releases,
post-release refresh, private access, and rollback.

## Safety Rules

- Ordinary development does not need production AWS access.
- Never store secrets or client data in the repository or a development
  workspace.
- Never deploy production from a feature branch or development computer.
- Never run bare `cdk deploy`.
- Never run `npm run destroy` without explicit installation-owner approval.
- Run the full `npm test` before pushing, as required by
  [CLAUDE.md](../CLAUDE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
