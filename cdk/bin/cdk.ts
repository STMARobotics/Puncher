#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BackendStack } from "../lib/backend-stack";
import { CertificateStack } from "../lib/certificate-stack";
import { config } from "../lib/config";
import { DeploymentIdentityStack } from "../lib/deployment-identity-stack";
import { FrontendStack } from "../lib/frontend-stack";

const app = new cdk.App();
cdk.Tags.of(app).add("AppName", "Puncher");
const props = (region: string): cdk.StackProps => ({
  env: { account: config.account, region },
  crossRegionReferences: true,
});
const cert = new CertificateStack(
  app,
  `puncher-certificate`,
  props("us-east-1"),
  config,
);
const backend = new BackendStack(
  app,
  `puncher-backend`,
  props("us-east-2"),
  config,
);
new FrontendStack(
  app,
  `puncher-frontend`,
  props("us-east-2"),
  config,
  backend,
  cert.certificate,
);
if (app.node.tryGetContext("identity"))
  new DeploymentIdentityStack(
    app,
    `puncher-deployment-identity`,
    props("us-east-2"),
    config,
  );
