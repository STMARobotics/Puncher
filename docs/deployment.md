# AWS DEPLOYMENT

The production domain is puncher.7028robotics.com. No AWS resources were deployed during implementation. Puncher does not reuse another app's OAuth client, AWS resource, or deployment role. Application resources run in us-east-2 and the CloudFront certificate in us-east-1.

The single configuration is in `cdk/lib/config.ts`; CDK synthesizes one fixed set of Puncher stacks. Schema v2 provisions a fresh DynamoDB table named `puncher-data`. CloudFormation retains the previous table under its existing retention policy. The separate Stats deployment must adopt the v2 reader contract and point to the new table outputs. Puncher stores OAuth state and seven-day server sessions in this existing table; DynamoDB TTL cleans up expired rows. Session cookies are Secure, HttpOnly and SameSite=Lax. Sessions are independent of other apps and do not require a shared database.

## Google OAuth setup

Create a new OAuth app/client in the Google Cloud project for Puncher; use a separate OAuth client for the Angular app. In Google Auth Platform:

1. Configure the app name, support email, and authorized domain `7028robotics.com`. Set the audience to **Internal** for the `stmarobotics.org` Workspace organization. This OAuth flow requests only the standard `openid` and `email` scopes.
2. Create an OAuth client with application type **Web application**. Add this exact authorized redirect URI: `https://puncher.7028robotics.com/api/auth/callback`. For local real-Google testing, also add `http://localhost:5173/api/auth/callback`. No JavaScript origin is needed for this server-side redirect flow.
3. Copy the new client ID into `googleClientId` in `cdk/lib/config.ts`. Keep the client secret private; it is not placed in the repository or public `config.json`.
4. In AWS Systems Manager Parameter Store in **us-east-2**, create `/puncher/google-client-secret` as a **Standard** tier **SecureString**, using the AWS-owned `alias/aws/ssm` key, and set its value to the OAuth client secret. Do this before deploying. Standard Parameter Store has no per-parameter monthly fee. The Staff Lambda has permission to read/decrypt only this parameter and caches the value for its execution environment.

The callback uses state, nonce and PKCE, exchanges the authorization code in the backend, verifies Google's signed ID token, then creates a random opaque session. The session value itself is hashed before DynamoDB storage. Google sign-in credentials and the OAuth client secret are never sent to browser storage. Google may show consent on the first authorization; later sign-ins generally reuse the user's Google session and existing grant. Keep the consent screen internal so only Workspace accounts can authorize; the backend independently verifies issuer, audience, expiration, subject, verified email and hosted domain, then rechecks Puncher permissions on every request.

## Google Wallet attendance pass setup

The member barcode can be saved as a Google Wallet Generic pass. Pass JWTs are signed by the Staff Lambda and sent directly to Google's save flow; Puncher does not call the Wallet REST API to issue each pass or use a paid pass-generation service.

1. In the [Google Pay & Wallet Console](https://pay.google.com/business/console/), create a Google Wallet API Issuer account for STMA Robotics. The issuer dashboard displays the numeric **Issuer ID**. This is separate from the OAuth client and from the Google Cloud project number.
2. In the [Google Cloud Console](https://console.cloud.google.com/), select the project for Puncher. Under **APIs & Services → Library**, enable **Google Wallet API**. Under **IAM & Admin → Service Accounts**, create a service account and create/download a JSON key. In the Google Pay & Wallet Console, go to **Users → Invite a user** and grant that service account email the **Developer** role for the issuer.
3. In the Google Pay & Wallet Console, create a **Generic** pass class for attendance. Use the class ID `<ISSUER_ID>.attendance` (for example, `1234567890123456789.attendance`) and record the full ID. Set the issuer name to STMA Robotics. Add the exact class ID to `googleWalletClassId` in `cdk/lib/config.ts`. The frontend displays the Wallet link only when that ID is configured.
4. In AWS Systems Manager → Parameter Store in **us-east-2**, create `/puncher/google-wallet-service-account` as a **Standard** tier **SecureString**, using the AWS-owned `alias/aws/ssm` key. Set its value to the service account JSON key contents (minified to one line if needed). The Staff Lambda receives permission to read/decrypt only this parameter and caches it for its execution environment. Do not put the private key in source control or CDK configuration.
5. For local testing, put the same one-line JSON in `.env` as `GOOGLE_WALLET_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'` and set `GOOGLE_WALLET_CLASS_ID=<ISSUER_ID>.attendance`. Keep the JSON's private-key `\n` escapes intact. The sample `.env.example` leaves these values blank. Use a Google account registered as an issuer admin/developer or Wallet test account when trying a Demo Mode pass.
6. Deploy after setting the class ID and creating the SSM parameter. When the issuer is in Demo Mode, only issuer admins, developers, and configured test users can save passes. To offer this to all members, request publishing access in the Wallet Console; Google's current requirements include a completed Business Profile and associated payments profile.

Google's published setup describes the Issuer account and Wallet API but does not state a fee for issuing passes with this signed-JWT flow. Standard SSM Parameter Store has no per-parameter monthly fee. Confirm any current Cloud project or account requirements in Google Console before enabling production; no paid external wallet service is added by this implementation.

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

After deployment, use an authorized AWS operator shell with `APP_ENV=prod`, `TABLE_NAME=puncher-data`, and `AWS_REGION=us-east-2`. Remove local endpoint and fixture settings from that shell.

1. Run `npm run provision -- schema` to initialize the table.
2. Have the intended first Admin sign in with their school Google account. From the same signed-in browser, open `/api/me` and record the returned `id`.
3. Set `$env:CONFIRM_BOOTSTRAP='true'` and run `npm run provision -- bootstrap-admin GOOGLE_SUB administrator@stmarobotics.org` with the exact ID and email. The command promotes the existing account once and keeps its barcode.
4. Reload Puncher. Use **Manage members** to change roles after those members sign in.

Subscribe operations staff to the AlarmTopicArn output and confirm delivery before launch. Alarms cover handler errors, API server errors, cleanup missing invocation and DLQ messages. EventBridge Scheduler invokes local midnight with America/Chicago timezone, flexible window OFF, retries and failure queue. Lambda async failure destination also catches execution failures. Inspect a failed invocation and rerun Cleanup with `{}`; pagination and exact-session conditional transactions safely catch up. Scan/read APIs enforce cutoff while cleanup is delayed. No restore/adjustment endpoint exists for forfeited time.

Activate the exact case-sensitive user-defined `AppName` key in AWS Billing → Cost allocation tags (https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html). Then filter/group Cost Explorer by AppName=Puncher and Environment. Tagging alone does not activate billing allocation. Confirm both-region resources using Resource Groups Tag Editor or Resource Explorer, including table, buckets, CloudFront, functions/log groups, IAM, queues, alarms, topics, API and certificate where tagging is supported. Every supported resource must have AppName=Puncher, never FMEA/Stats/Timeclock. Production table and shared table read charges belong to Puncher; see stats-integration.md.

CDK's current bundled minimatch has a moderate development-time denial-of-service advisory (GHSA-g3hv-75wg-m249) reported by npm audit with no upstream compatible fix. It is part of infrastructure packaging, not an exposed request path; only trusted repository asset globs are used. Recheck npm audit and the CDK release before production deployment. Do not claim a clean dependency security audit until upstream resolves it.
