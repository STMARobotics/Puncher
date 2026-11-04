import { App, Stack, aws_dynamodb as ddb, aws_lambda as lambda } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { IntegrationStack } from '../infra/integration-stack';
import {
  activityStream,
  configureActivityPublisher,
  integrationSettings,
  activityInputTemplate,
  activityOutboxPrefixes,
} from '../infra/activity-publisher';
it('retains the separate organization bus and filters its archive', () => {
  const app = new App({ outdir: resolve('work/activity-hub-cdk') });
  const stack = new IntegrationStack(app, 'organization-integration', {
    env: { account: '111111111111', region: 'us-east-2' },
    orgId: 'example-team',
    environment: 'validation',
  });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::Events::EventBus', 1);
  t.hasResourceProperties('AWS::Events::Archive', {
    RetentionDays: 90,
    EventPattern: { detail: { orgId: ['example-team'] } },
  });
  expect(Object.values(t.findResources('AWS::Events::EventBus'))[0].DeletionPolicy).toBe('Retain');
});
it('keeps publishing opt-in and sets exact bus grants and filtered INSERT-only delivery', () => {
  const app = new App({
    outdir: resolve('work/activity-publisher-cdk'),
    context: {
      activityIntegration: {
        orgId: 'example-team',
        busArn: 'arn:aws:events:us-east-2:111111111111:event-bus/activity',
        pipeEnabled: true,
        captureEnabled: true,
      },
    },
  });
  const stack = new Stack(app, 'publisher', {
    env: { account: '111111111111', region: 'us-east-2' },
  });
  const table = new ddb.Table(stack, 'Table', {
    partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
    sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
    stream: activityStream(stack),
  });
  const fn = new lambda.Function(stack, 'Writer', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler=async()=>{}'),
  });
  configureActivityPublisher(stack, table, [fn], 'puncher');
  const t = Template.fromStack(stack);
  t.hasResourceProperties('AWS::Pipes::Pipe', {
    DesiredState: 'RUNNING',
    SourceParameters: {
      DynamoDBStreamParameters: {
        StartingPosition: 'TRIM_HORIZON',
        MaximumRecordAgeInSeconds: 82800,
      },
    },
  });
  const pipe = Object.values(t.findResources('AWS::Pipes::Pipe'))[0] as any;
  expect(activityOutboxPrefixes(stack, 'puncher')).toEqual(['OUTBOX#example-team#puncher#*']);
  const resources = t.toJSON().Resources;
  expect(
    (pipe.DependsOn ?? []).some((id: string) => resources[id]?.Type === 'AWS::IAM::Policy'),
  ).toBe(true);
  expect(
    JSON.parse(pipe.Properties.SourceParameters.FilterCriteria.Filters[0].Pattern),
  ).toMatchObject({
    eventName: ['INSERT'],
    dynamodb: { NewImage: { recordType: { S: ['ACTIVITY_OUTBOX_V1'] } } },
  });
  expect(pipe.Properties.TargetParameters.InputTemplate).toBe(activityInputTemplate);
  expect(pipe.Properties.TargetParameters.InputTemplate).not.toMatch(/password|email|barcode/);
  expect(JSON.stringify(t.toJSON())).toContain('org.apps.puncher');
});
it('rejects cross-account targets and capture before a running pipe', () => {
  for (const settings of [
    { orgId: 123, busArn: 'arn:aws:events:us-east-2:111111111111:event-bus/activity' },
    { orgId: 'example-team', busArn: 'arn:aws:events:us-east-2:222222222222:event-bus/activity' },
    {
      orgId: 'example-team',
      busArn: 'arn:aws:events:us-east-2:111111111111:event-bus/activity',
      captureEnabled: true,
    },
  ]) {
    const app = new App({ context: { activityIntegration: settings } });
    const stack = new Stack(app, 'invalid', {
      env: { account: '111111111111', region: 'us-east-2' },
    });
    expect(() => integrationSettings(stack)).toThrow();
  }
});
it('grants no outbox prefixes when integration is absent', () => {
  const stack = new Stack(new App(), 'default', {
    env: { account: '111111111111', region: 'us-east-2' },
  });
  expect(activityOutboxPrefixes(stack, 'puncher')).toEqual([]);
});
