// Separate entry point: existing deployment commands do not deploy the organization bus.
import { App, Tags } from 'aws-cdk-lib';
import { IntegrationStack } from '../lib/integration-stack';
const app = new App();
const validation =
  app.node.tryGetContext('validation') === 'true' || app.node.tryGetContext('validation') === true;
const account = validation ? '111111111111' : process.env.INTEGRATION_ACCOUNT;
const orgId = validation ? 'example-team' : process.env.INTEGRATION_ORG_ID;
const environment = validation ? 'validation' : process.env.INTEGRATION_ENV;
if (!account || !/^\d{12}$/.test(account) || !orgId || !environment)
  throw new Error('Set INTEGRATION_ACCOUNT, INTEGRATION_ORG_ID and INTEGRATION_ENV.');
Tags.of(app).add('AppName', 'OrganizationIntegration');
Tags.of(app).add('Environment', environment);
new IntegrationStack(app, 'organization-' + environment + '-integration', {
  orgId,
  environment,
  env: { account, region: 'us-east-2' },
});
