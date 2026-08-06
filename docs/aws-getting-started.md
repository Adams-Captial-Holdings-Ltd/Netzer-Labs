# Getting started with AWS (the handholding prerequisites)

> **Where you are:** the first three steps of the install order. 1) AWS
> account, 2) AWS CLI v2 + credentials (plus Node 20+; Docker optional), 3)
> Bedrock model access. This page covers those three. Steps 4-5 are
> `npm ci --ignore-scripts` and `npm run up`, which conducts the rest of
> the install for you.

> This page walks a human through the AWS-side setup the install cannot do for itself: creating a standalone account, installing and configuring the AWS CLI, proving the credentials work, and granting Bedrock model access. It is written so an AI agent partner can read it and guide you step by step, pausing for you at each [HUMAN] step and confirming the result with a read-only check before moving on. Once these prerequisites are green, one command finishes the job: `npm run up` (it conducts the whole install and waits through the remaining human gates for you). The phase-by-phase agent runbook in [agent-setup.md](./agent-setup.md) is the alternative when you want every safety rail spelled out.

## For the AI agent partner driving this

You (the agent) cannot create an AWS account, click the Bedrock console, or type a one-time SMS code. Those are [HUMAN] steps. Your job here is to be a patient partner: present ONE step at a time, tell the operator exactly what to do, wait, then run the read-only verification command and only advance when it passes. Never ask for or store an access key in chat. After these prerequisites pass, run `npm run up` (see [AGENTS.md](../AGENTS.md) at the repo root for the short agent runbook) or switch to [agent-setup.md](./agent-setup.md) for the phase-by-phase path; either way, drive only the typed `npm run` commands and do not improvise raw `aws`/`cdk` calls during the install.

The only AWS CLI commands used on this page are read-only identity checks (`aws configure list`, `aws sts get-caller-identity`). They create nothing and cost nothing.

## Step 1 [HUMAN] Create a brand-new standalone AWS account

The install requires a fresh account that is empty except for what it creates, and is NOT part of an AWS Organization or Control Tower. This is a deliberate safety boundary: the isolation scanner refuses to provision into a non-empty or managed account, so a shared account will be blocked in Phase 3.

- Sign up at https://aws.amazon.com with a NEW email alias and a payment card. Activation can lag from minutes to a few hours because of card and phone verification.
- Do not reuse a company account or an Organizations member account. If `npm run doctor` later reports `unsupported-account-profile`, the account is managed and cannot be used for this path.

## Step 2 [HUMAN] Install the AWS CLI v2

Pick your platform. Verify with `aws --version` (expect `aws-cli/2.x`).

```bash
# macOS (Homebrew)
brew install awscli

# macOS (official installer — .pkg, works on Intel and Apple Silicon)
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /

# Linux x86_64 (for ARM/Graviton use awscli-exe-linux-aarch64.zip instead)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip awscliv2.zip && sudo ./aws/install

# Windows: download and run https://awscli.amazonaws.com/AWSCLIV2.msi
```

Then confirm:

```bash
aws --version
```

## Step 3 [HUMAN] Configure credentials

Two supported ways. Short-lived credentials (Option B) are preferred because the install drops admin authority after bootstrap and a long-lived access key left in your environment is flagged by the credential guard.

### Option A. IAM Identity Center / AWS SSO (recommended, short-lived)

```bash
aws configure sso
# follow the browser prompts; pick the admin permission set and your region
# this writes an [sso-session] + a named profile to ~/.aws/config
```

Use it for a session with:

```bash
aws sso login --profile <your-profile>
export AWS_PROFILE=<your-profile>
```

### Option B. IAM user access key (simplest)

In the AWS console, create an IAM user with AdministratorAccess (bootstrap-only; the scoped role replaces it), generate an access key, then:

```bash
aws configure
# AWS Access Key ID:     <paste>
# AWS Secret Access Key: <paste>
# Default region name:   us-east-1   (or your chosen deploy region)
# Default output format: json
```

Do not paste the secret key into any chat or commit it. The agent partner must never request it.

## Step 4 Verify the credentials work (read-only)

This is the agent's checkpoint before anything proceeds. It creates nothing.

```bash
aws configure list
aws sts get-caller-identity
```

A JSON object with an `Account` and an `Arn` means the CLI is wired correctly. An `Account` that is all you expected (a brand-new, otherwise-empty account) is what Phase 3 will require.

## Step 5 [HUMAN] Grant Bedrock model access (Anthropic Claude)

Since AWS simplified Bedrock model access in October 2025, serverless foundation models from most providers are enabled automatically on first use, and the old per-model "Model access" dashboard (along with the `PutFoundationModelEntitlement` permission) was retired. Anthropic Claude is the one model this deploy calls that still requires a one-time use-case form before its first invocation. Access is granted immediately on submission but can take a few minutes to propagate.

- Open the Bedrock **model catalog** for your region: `https://console.aws.amazon.com/bedrock/home?region=<your-region>#/model-catalog`. Select an Anthropic Claude model and submit the one-time use-case form. (The same form can be submitted with the `PutUseCaseForModelAccess` API; in an AWS Organization, submitting once at the management account covers member accounts.)
- The other models this deploy may call are auto-enabled on first invocation given a valid payment method, so they need no manual request: Titan Embed v2 (only if you enable knowledge ingest), Amazon Nova Sonic (only for Jarvis voice), and a Stability image model (only for image generation, `us-west-2`). The agent's `npm run doctor -- --envelope` reports the precise model ids and each one's access state, so let it tell you what (if anything) still needs the Anthropic form.
- Submitting the form is free, and Bedrock usage is billed per token/image at use time, bounded by the daily cap. The standing AWS infrastructure this install creates bills separately — see [cost-guide.md](./cost-guide.md).

## Step 6 Confirm the local toolchain

```bash
node --version    # expect v20 or newer
docker info        # OPTIONAL: without Docker, deploy builds in CodeBuild in your account
```

## You are ready. Hand off to the install.

When Steps 1 to 6 are green, the AWS-side prerequisites are done. From here the agent drives the typed commands, starting with the zero-cost pass:

```bash
npm ci --ignore-scripts
npm run validate:tier1     # read-only Phases 1-3, creates nothing, $0
```

Then `npm run up` conducts the full install in one command (it pauses at each human gate with the exact console URL and continues on its own once you have clicked through). Prefer granular control? [agent-setup.md](./agent-setup.md) covers Phases 0 to 7 (the full install, the human gates, the DONE predicate, and `npm run destroy` to stop). For what it will cost once real infrastructure goes up, read [cost-guide.md](./cost-guide.md); when a check fails, [troubleshooting.md](./troubleshooting.md) has the per-check fix.
