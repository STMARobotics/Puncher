import { it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { config } from "../lib/config";
import { DeploymentIdentityStack } from "../lib/deployment-identity-stack";
// Synthesis runs before this suite in CI. Pure domain tests can run without a CDK output directory.
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

it("configures the GitHub workflow to assume the synthesized deployment role", () => {
  const app = new cdk.App();
  const stack = new DeploymentIdentityStack(
    app,
    "puncher-deployment-identity-test",
    { env: { account: config.account, region: "us-east-2" } },
    config,
  );
  const template = Template.fromStack(stack);
  template.hasResourceProperties("AWS::IAM::Role", {
    RoleName: "puncher-github-deploy",
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        {
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub": `repo:${config.repository}:environment:puncher`,
            },
          },
          Effect: "Allow",
          Principal: {
            Federated: `arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`,
          },
        },
      ]),
    },
  });
  const workflow = readFileSync(
    resolve(projectRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  expect(workflow).toContain(
    `role-to-assume: arn:aws:iam::${config.account}:role/puncher-github-deploy`,
  );
});

it.skipIf(
  !existsSync(
    resolve(projectRoot, "cdk/cdk.out/puncher-backend.template.json"),
  ),
)(
  "synthesized topology protects records, auth, scheduler and resource tags",
  () => {
    const load = (name: string) =>
      JSON.parse(
        readFileSync(
          resolve(
            projectRoot,
            `cdk/cdk.out/puncher-${name}.template.json`,
          ),
          "utf8",
        ),
      );
    const backend = load("backend"),
      frontend = load("frontend"),
      cert = load("certificate");
    Template.fromJSON(backend).hasResourceProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: true,
      BillingMode: "PAY_PER_REQUEST",
      Tags: Match.arrayWith([{ Key: "AppName", Value: "Puncher" }]),
    });
    Template.fromJSON(backend).hasResourceProperties(
      "AWS::ApiGatewayV2::Route",
      { RouteKey: "GET /api/kiosk/totals", AuthorizationType: "CUSTOM" },
    );
    const resources = (t: any, type: string) =>
      Object.values(t.Resources).filter((r: any) => r.Type === type) as any[];
    for (const fn of resources(backend, "AWS::Lambda::Function")) {
      expect(fn.Properties.FunctionName).toMatch(/^puncher-/);
      expect(fn.Properties.Environment.Variables.APP_ENV).toBe("prod");
    }
    for (const log of resources(backend, "AWS::Logs::LogGroup"))
      expect(log.Properties.LogGroupName).toMatch(/^\/puncher\/[^/]+$/);
    const table = resources(backend, "AWS::DynamoDB::Table")[0];
    expect(table.Properties.StreamSpecification).toBeUndefined();
    expect(resources(backend, "AWS::Pipes::Pipe")).toHaveLength(0);
    for (const fn of resources(backend, "AWS::Lambda::Function"))
      expect(fn.Properties.Environment.Variables.INTEGRATION_ENABLED).toBeUndefined();
    expect(table.DeletionPolicy).toBe("Retain");
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
    expect(
      table.Properties.PointInTimeRecoverySpecification
        .PointInTimeRecoveryEnabled,
    ).toBe(true);
    expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
    const schedule = resources(backend, "AWS::Scheduler::Schedule")[0]
      .Properties;
    expect(schedule.ScheduleExpressionTimezone).toBe("America/Chicago");
    expect(schedule.FlexibleTimeWindow.Mode).toBe("OFF");
    expect(schedule.Target.RetryPolicy.MaximumRetryAttempts).toBeGreaterThan(0);
    expect(schedule.Target.DeadLetterConfig).toBeTruthy();
    for (const a of resources(backend, "AWS::ApiGatewayV2::Authorizer"))
      expect(a.Properties.AuthorizerResultTtlInSeconds).toBe(0);
    const distribution = resources(frontend, "AWS::CloudFront::Distribution")[0]
      .Properties.DistributionConfig;
    expect(
      distribution.CacheBehaviors.every(
        (b: any) => b.CachePolicyId === "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      ),
    ).toBe(true);
    expect(
      distribution.CacheBehaviors.every(
        (b: any) => !b.FunctionAssociations?.length,
      ),
    ).toBe(true);
    expect(distribution.DefaultCacheBehavior.FunctionAssociations).toHaveLength(
      1,
    );
    expect(
      resources(frontend, "AWS::S3::Bucket")[0].Properties
        .PublicAccessBlockConfiguration.BlockPublicPolicy,
    ).toBe(true);
    for (const t of [backend, frontend, cert])
      for (const r of Object.values(t.Resources) as any[]) {
        const tags = r.Properties?.Tags;
        if (Array.isArray(tags)) {
          expect(tags).toContainEqual({ Key: "AppName", Value: "Puncher" });
          expect(tags.some((tag: any) => tag.Key === "Environment")).toBe(
            false,
          );
        }
      }
    expect(JSON.stringify(backend)).not.toContain("LOCAL_AUTH_FIXTURES");
  },
);
