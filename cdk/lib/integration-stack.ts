import { Stack, Duration, CfnOutput, RemovalPolicy, aws_events as events } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
export class IntegrationStack extends Stack {
  readonly bus: events.EventBus;
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { orgId: string; environment: string },
  ) {
    super(scope, id, props);
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(props.orgId) ||
      !['dev', 'prod', 'validation'].includes(props.environment)
    )
      throw new Error('Explicit organization and environment required.');
    this.bus = new events.EventBus(this, 'ActivityBus', {
      eventBusName: props.orgId + '-' + props.environment + '-activity',
    });
    this.bus.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const archive = new events.Archive(this, 'ActivityArchive', {
      sourceEventBus: this.bus,
      retention: Duration.days(90),
      eventPattern: {
        source: ['org.apps.puncher', 'org.apps.packs', 'org.apps.fmea'],
        detail: { orgId: [props.orgId] },
      },
    });
    archive.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, 'ActivityBusArn', { value: this.bus.eventBusArn });
    new CfnOutput(this, 'ActivityArchiveArn', { value: archive.archiveArn });
  }
}
