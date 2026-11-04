# AWS DEPLOYMENT

The production domain is puncher.7028robotics.com. No AWS resources were deployed during implementation. Puncher uses the AWS account, hosted-zone ID, and public Google OAuth client ID from fmea-app, as explicitly approved; it does not reuse FMEA resources or deployment roles. Application resources run in us-east-2 and the CloudFront certificate in us-east-1.

The single configuration is in `cdk/lib/config.ts`; CDK synthesizes one fixed set of Puncher stacks. The DynamoDB table name remains `puncher-prod-records` for the existing read-only Stats integration contract. The OAuth web client must authorize the Puncher and Stats HTTPS domains and local `http://localhost:5173` if used. The confirmed Workspace domain is `stmarobotics.org`. Public `config.json` contains only the client ID, domain, timezone, display link and capability flags; no OAuth client secret is needed. Google verifies its JWT signature using Google's maintained library, then the server checks issuer, audience, expiration, subject, email verification, and hosted domain. Every request rechecks persisted app permissions.

Use AWS SSO for initial infrastructure setup. Bootstrap both regions using the standard CDK qualifier and toolkit stack, with an execution policy restricted to Puncher resources plus the selected hosted zone. Review that policy for your account before creating it:

```powershell
npm exec --workspace=cdk -- cdk bootstrap aws://ACCOUNT/us-east-1 aws://ACCOUNT/us-east-2 --cloudformation-execution-policies arn:aws:iam::ACCOUNT:policy/PuncherDeploymentExecution
npm ci
npm run build
npm run cdk:synth
npm run cdk:diff
npm run cdk:deploy
```

Synthesis uses the same fixed production config as deployment and makes no AWS calls; it is safe in CI. Frontend build must exist before synthesis. Certificate, backend and frontend are separate stacks with explicit cross-region certificate references, retained records/PITR/deletion protection, private S3/OAC, and same-origin /api and /api/* behaviors. API responses are uncached; Authorization, device header, Origin and cookies forward to the API. SPA rewrites apply only to static frontend behavior. Default Lambda URLs are absent; direct API Gateway calls still require authorizers and backend checks. The mentor-authenticated launch endpoint creates a scoped kiosk session and sets a secure HttpOnly SameSite=Strict cookie; public manual setup has been retired. The direct scan endpoint accepts X-Device-Token as an alternative and enforces exact Origin for browser writes.

Create the account's GitHub OIDC provider operationally if absent, with provider URL `https://token.actions.githubusercontent.com` and client ID `sts.amazonaws.com`. With administrator credentials, deploy only the identity stack: `npm exec --workspace=cdk -- cdk deploy --app "npx tsx bin/cdk.ts" puncher-deployment-identity -c identity=true`. This creates role `puncher-github-deploy`; the workflow must assume that role ARN (not the stack name). Its trust is scoped to the GitHub immutable subject `repo:STMARobotics@32277731/Puncher@1443278208:environment:puncher` and audience `sts.amazonaws.com`. Bootstrap both regions as described above so the role can assume the standard CDK bootstrap roles; their CloudFormation execution policy must permit the Puncher deployment. Configure the protected GitHub environment `puncher` to allow `main`. The workflow grants `id-token: write` and uses short-lived OIDC credentials; no GitHub secrets or AWS access keys are used.

CI validates pushes and pull requests without AWS credentials and never deploys them. A push to `main` automatically deploys after all validation—including database and browser tests—succeeds.

After deployment use an authorized operator shell with APP_ENV=prod, TABLE_NAME=puncher-prod-records, no local endpoint/fixture flags, AWS_REGION=us-east-2, GOOGLE_CLIENT_ID and ALLOWED_ORIGIN set:

```powershell
npm run provision -- schema
$env:CONFIRM_BOOTSTRAP='true'
npm run provision -- bootstrap-admin VERIFIED_GOOGLE_SUB administrator@stmarobotics.org
```

Get the stable subject from a server-verified Google credential for the intended account; never copy an unverified decoded token. This is an AWS-authorized command, not an anonymous API. Bootstrap is once only. New mentors sign in once and a mentor administrator approves their verified request. Attendance members are managed by mentors through the roster UI, including optional Google Directory sync, automatic six-digit codes and CSV export for external ID-card generation. Existing identity/member links and native history IDs are retained; no matching by name or email is performed. Kiosks launch from mentor login, expire after 12 hours and can be revoked. Disabling the launching mentor invalidates that mentor's kiosk sessions. See [mentor roster and Google setup](mentor-roster.md) for the one-time Workspace authorization, opt-in infrastructure, migration/linking and retry behavior. The Stats read contract and EventBridge activity contracts remain unchanged.

Subscribe operations staff to the AlarmTopicArn output and confirm delivery before launch. Alarms cover handler errors, API server errors, cleanup missing invocation and DLQ messages. EventBridge Scheduler invokes local midnight with America/Chicago timezone, flexible window OFF, retries and failure queue. Lambda async failure destination also catches execution failures. Inspect a failed invocation and rerun Cleanup with `{}`; pagination and exact-session conditional transactions safely catch up. Scan/read APIs enforce cutoff while cleanup is delayed. No restore/adjustment endpoint exists for forfeited time.

Activate the exact case-sensitive user-defined `AppName` key in AWS Billing → Cost allocation tags (https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html). Then filter/group Cost Explorer by AppName=Puncher and Environment. Tagging alone does not activate billing allocation. Confirm both-region resources using Resource Groups Tag Editor or Resource Explorer, including table, buckets, CloudFront, functions/log groups, IAM, queues, alarms, topics, API and certificate where tagging is supported. Every supported resource must have AppName=Puncher, never FMEA/Stats/Timeclock. Production table and shared table read charges belong to Puncher; see stats-integration.md.

CDK's current bundled minimatch has a moderate development-time denial-of-service advisory (GHSA-g3hv-75wg-m249) reported by npm audit with no upstream compatible fix. It is part of infrastructure packaging, not an exposed request path; only trusted repository asset globs are used. Recheck npm audit and the CDK release before production deployment. Do not claim a clean dependency security audit until upstream resolves it.
