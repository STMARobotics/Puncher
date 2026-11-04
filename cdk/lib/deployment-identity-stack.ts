import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { Config } from "./config";
export class DeploymentIdentityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps, c: Config) {
    super(scope, id, props);
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GithubProvider",
      `arn:aws:iam::${c.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const role = new iam.Role(this, "DeploymentRole", {
      roleName: `puncher-github-deploy`,
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": `repo:${c.repository}:environment:puncher`,
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${c.account}:role/cdk-hnb659fds-*-${c.account}-us-east-1`,
          `arn:aws:iam::${c.account}:role/cdk-hnb659fds-*-${c.account}-us-east-2`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:cloudformation:*:${c.account}:stack/puncher-*/*`,
          `arn:aws:cloudformation:*:${c.account}:stack/CDKToolkit/*`,
        ],
      }),
    );
    new cdk.CfnOutput(this, "RoleArn", { value: role.roleArn });
  }
}
