import * as cdk from "aws-cdk-lib";
import { config } from "./config";
import {
  CertificateStack,
  BackendStack,
  FrontendStack,
  DeploymentIdentityStack,
} from "./stacks";
const app = new cdk.App();
const c = config(
  Object.fromEntries(
    [
      "validation",
      "account",
      "environment",
      "domain",
      "zoneName",
      "zoneId",
      "googleClientId",
      "statsUrl",
      "repository",
    ].map((k) => [k, app.node.tryGetContext(k)]),
  ),
);
cdk.Tags.of(app).add("AppName", "Puncher");
cdk.Tags.of(app).add("Environment", c.environment);
const props = (region: string): cdk.StackProps => ({
  env: { account: c.account, region },
  crossRegionReferences: true,
  synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: "puncher" }),
});
const cert = new CertificateStack(
  app,
  `puncher-${c.environment}-certificate`,
  props("us-east-1"),
  c,
);
const backend = new BackendStack(
  app,
  `puncher-${c.environment}-backend`,
  props("us-east-2"),
  c,
);
new FrontendStack(
  app,
  `puncher-${c.environment}-frontend`,
  props("us-east-2"),
  c,
  backend,
  cert.certificate,
);
if (app.node.tryGetContext("identity"))
  new DeploymentIdentityStack(
    app,
    `puncher-${c.environment}-deployment-identity`,
    props("us-east-2"),
    c,
  );
