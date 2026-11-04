import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { resolve } from "node:path";
import { BackendStack } from "../lib/backend-stack";
import { config } from "../lib/config";

it("isolates the opt-in manual roster worker and keeps mentor launch behind human auth", () => {
  const secret =
    "arn:aws:secretsmanager:us-east-2:111111111111:secret:google-roster-ABCdef";
  const app = new App({
    outdir: resolve("work/roster-cdk"),
    context: {
      rosterSync: {
        domain: "stmarobotics.org",
        delegatedAdminEmail: "reader@stmarobotics.org",
        credentialsSecretArn: secret,
      },
    },
  });
  const stack = new BackendStack(
    app,
    "roster-backend",
    { env: { account: "111111111111", region: "us-east-2" } },
    { ...config, account: "111111111111" },
  );
  const t = Template.fromStack(stack);
  const functions = Object.values(
    t.findResources("AWS::Lambda::Function"),
  ) as any[];
  const worker = functions.find(
    (r) => r.Properties.FunctionName === "puncher-rostersync",
  );
  expect(worker.Properties).toMatchObject({
    Timeout: 300,
    ReservedConcurrentExecutions: 1,
  });
  for (const fn of functions.filter((r) => r !== worker))
    expect(
      fn.Properties.Environment.Variables.GOOGLE_ROSTER_SECRET_ARN,
    ).toBeUndefined();
  const policies = Object.entries(t.findResources("AWS::IAM::Policy"));
  for (const [id, resource] of policies) {
    const statements = (resource as any).Properties.PolicyDocument.Statement;
    for (const statement of statements)
      if (
        JSON.stringify(statement.Action).includes(
          "secretsmanager:GetSecretValue",
        )
      ) {
        expect(id).toMatch(/^RosterSync/);
        expect(statement.Resource).toBe(secret);
      }
  }
  const workerPolicy: any = policies.find(([id]) =>
    id.startsWith("RosterSyncServiceRoleDefaultPolicy"),
  )?.[1];
  expect(workerPolicy).toBeDefined();
  const totalsPolicy: any = policies.find(([id]) =>
    id.startsWith("ShopTotalsServiceRoleDefaultPolicy"),
  )?.[1];
  expect(
    totalsPolicy.Properties.PolicyDocument.Statement.some(
      (s: any) =>
        JSON.stringify(s.Action).includes("dynamodb:ConditionCheckItem") &&
        s.Condition?.["ForAllValues:StringLike"]?.[
          "dynamodb:LeadingKeys"
        ]?.includes("IDENTITY#*"),
    ),
  ).toBe(true);
  for (const statement of workerPolicy.Properties.PolicyDocument.Statement)
    if (JSON.stringify(statement.Action).includes("dynamodb:PutItem"))
      expect(
        statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"],
      ).not.toContain("IDENTITY#*");
  const queues = Object.values(t.findResources("AWS::SQS::Queue")) as any[];
  expect(queues.filter((r) => r.Properties.FifoQueue)).toHaveLength(2);
  t.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
  t.resourceCountIs("AWS::Scheduler::Schedule", 1); // existing midnight cleanup only
  const routes = Object.values(
    t.findResources("AWS::ApiGatewayV2::Route"),
  ) as any[];
  expect(
    routes.find((r) => r.Properties.RouteKey === "ANY /api/mentor/{proxy+}")
      .Properties.AuthorizationType,
  ).toBe("CUSTOM");
  expect(
    routes.some((r) => r.Properties.RouteKey.includes("kiosk/setup")),
  ).toBe(false);
  for (const owner of ["Kiosk", "DeviceAuthorizer"]) {
    const p: any = policies.find(([id]) =>
      id.startsWith(owner + "ServiceRoleDefaultPolicy"),
    )?.[1];
    expect(p).toBeDefined();
    for (const statement of p.Properties.PolicyDocument.Statement)
      if (JSON.stringify(statement.Action).includes("dynamodb:PutItem"))
        expect(
          statement.Condition["ForAllValues:StringLike"][
            "dynamodb:LeadingKeys"
          ],
        ).not.toContain("IDENTITY#*");
  }
});
