import * as cdk from "aws-cdk-lib";
import {
  aws_dynamodb as ddb,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_apigatewayv2 as http,
  aws_apigatewayv2_authorizers as auth,
  aws_apigatewayv2_integrations as integrations,
  aws_iam as iam,
  aws_sqs as sqs,
  aws_scheduler as scheduler,
  aws_cloudwatch as cw,
  aws_sns as sns,
  aws_cloudwatch_actions as actions,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { resolve } from "node:path";
import type { Config } from "./config";
const projectRoot = resolve(__dirname, "../..");
export class BackendStack extends cdk.Stack {
  readonly table: ddb.Table;
  readonly api: http.HttpApi;
  constructor(scope: Construct, id: string, props: cdk.StackProps, c: Config) {
    super(scope, id, props);
    const prefix = "puncher";
    this.table = new ddb.Table(this, "Records", {
      tableName: c.tableName,
      partitionKey: { name: "pk", type: ddb.AttributeType.STRING },
      sortKey: { name: "sk", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: "ttl",
      encryption: ddb.TableEncryption.AWS_MANAGED,
    });
    for (const i of [1, 2])
      this.table.addGlobalSecondaryIndex({
        indexName: `GSI${i}`,
        partitionKey: { name: `gsi${i}pk`, type: ddb.AttributeType.STRING },
        sortKey: { name: `gsi${i}sk`, type: ddb.AttributeType.STRING },
        projectionType: ddb.ProjectionType.ALL,
      });
    const topic = new sns.Topic(this, "OperationalAlarms", {
      topicName: `${prefix}-alarms`,
    });
    const dlq = new sqs.Queue(this, "CleanupFailures", {
      queueName: `${prefix}-cleanup-failures`,
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    const create = (
      name: string,
      entry: string,
      handler: string,
      extra: Record<string, string> = {},
    ) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/puncher/${name}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const f = new nodejs.NodejsFunction(this, name, {
        functionName: `${prefix}-${name.toLowerCase()}`,
        entry: resolve(projectRoot, entry),
        handler,
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(name === "Cleanup" ? 900 : 25),
        logGroup,
        bundling: {
          format: nodejs.OutputFormat.CJS,
          target: "node24",
          minify: true,
          sourceMap: true,
          externalModules: [],
        },
        environment: {
          APP_ENV: "prod",
          TABLE_NAME: this.table.tableName,
          GOOGLE_CLIENT_ID: c.googleClientId,
          ALLOWED_ORIGIN: `https://${c.domain}`,
          STATS_URL: c.statsUrl,
          ...extra,
        },
      });
      new cw.Alarm(this, `${name}Errors`, {
        metric: f.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new actions.SnsAction(topic));
      return f;
    };
    const humans = create(
      "HumanAuthorizer",
      "service/auth.ts",
      "humanAuthorizer",
    );
    const devices = create(
      "DeviceAuthorizer",
      "service/auth.ts",
      "deviceAuthorizer",
    );
    const staff = create("Staff", "service/api.ts", "handler", {
      API_SCOPE: "staff",
    });
    const kiosk = create("Kiosk", "service/api.ts", "handler", {
      API_SCOPE: "kiosk",
    });
    const cleanup = create("Cleanup", "service/cleanup.ts", "handler");
    const totals = create("ShopTotals", "service/shop-totals.ts", "handler");
    totals.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["DEVICE#*", "APP#PUNCHER", "SUMMARY#SHOP"],
          },
        },
      }),
    );
    totals.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [this.table.tableArn, `${this.table.tableArn}/index/GSI1`],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MEMBERS", "MEMBER#*"],
          },
        },
      }),
    );
    totals.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [this.table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "DEVICE#*",
              "SUMMARY#SHOP",
              "RATE#device#*",
            ],
          },
        },
      }),
    );
    const permission = (
      f: lambda.Function,
      verbs: string[],
      prefixes?: string[],
      indexes = false,
    ) =>
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: verbs.map((x) => `dynamodb:${x}`),
          resources: [
            this.table.tableArn,
            ...(indexes ? [`${this.table.tableArn}/index/*`] : []),
          ],
          ...(prefixes
            ? {
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": prefixes,
                  },
                },
              }
            : {}),
        }),
      );
    permission(humans, ["GetItem"], ["IDENTITY#*", "MEMBER#*"]);
    permission(devices, ["GetItem"], ["DEVICE#*"]);
    permission(
      staff,
      ["GetItem", "Query", "PutItem", "DeleteItem", "ConditionCheckItem"],
      undefined,
      true,
    );
    permission(
      kiosk,
      ["GetItem", "Query", "PutItem", "DeleteItem", "ConditionCheckItem"],
      [
        "DEVICE#*",
        "MEMBER#*",
        "CARD#*",
        "OP#*",
        "RATE#device#*",
        "ACTIVE",
        "AUDIT",
        "APP#PUNCHER",
      ],
    );
    permission(
      cleanup,
      ["GetItem", "Query", "PutItem", "DeleteItem", "ConditionCheckItem"],
      ["ACTIVE", "MEMBER#*", "AUDIT"],
    );
    const humanAuth = new auth.HttpLambdaAuthorizer("HumanAuth", humans, {
      identitySource: ["$request.header.Authorization"],
      responseTypes: [auth.HttpLambdaResponseType.SIMPLE],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
    const deviceAuth = new auth.HttpLambdaAuthorizer("DeviceAuth", devices, {
      identitySource: [],
      responseTypes: [auth.HttpLambdaResponseType.SIMPLE],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
    this.api = new http.HttpApi(this, "Api", {
      apiName: `${prefix}-api`,
      createDefaultStage: true,
    });
    const staffIntegration = new integrations.HttpLambdaIntegration(
      "StaffIntegration",
      staff,
    );
    const kioskIntegration = new integrations.HttpLambdaIntegration(
      "KioskIntegration",
      kiosk,
    );
    this.api.addRoutes({
      path: "/api/kiosk/{proxy+}",
      methods: [http.HttpMethod.ANY],
      integration: kioskIntegration,
      authorizer: deviceAuth,
    });
    this.api.addRoutes({
      path: "/api/kiosk/totals",
      methods: [http.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "TotalsIntegration",
        totals,
      ),
      authorizer: deviceAuth,
    });
    this.api.addRoutes({
      path: "/api/kiosk/setup",
      methods: [http.HttpMethod.POST],
      integration: kioskIntegration,
    });
    this.api.addRoutes({
      path: "/api/health",
      methods: [http.HttpMethod.GET],
      integration: kioskIntegration,
    });
    for (const path of [
      "/api/me",
      "/api/events",
      "/api/events/{proxy+}",
      "/api/admin/{proxy+}",
    ])
      this.api.addRoutes({
        path,
        methods: [http.HttpMethod.ANY],
        integration: staffIntegration,
        authorizer: humanAuth,
      });
    const stage = this.api.defaultStage!.node.defaultChild as http.CfnStage;
    stage.defaultRouteSettings = {
      throttlingBurstLimit: 30,
      throttlingRateLimit: 20,
      detailedMetricsEnabled: true,
    };
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    });
    cleanup.grantInvoke(schedulerRole);
    dlq.grantSendMessages(schedulerRole);
    new scheduler.CfnSchedule(this, "Midnight", {
      name: `${prefix}-midnight`,
      scheduleExpression: "cron(0 0 * * ? *)",
      scheduleExpressionTimezone: "America/Chicago",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: cleanup.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: {
          maximumEventAgeInSeconds: 86400,
          maximumRetryAttempts: 185,
        },
        deadLetterConfig: { arn: dlq.queueArn },
        input: "{}",
      },
    });
    // Scheduler retries delivery; Lambda async failures are independently retried and sent to the same queue.
    cleanup.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(6),
      onFailure: { bind: () => ({ destination: dlq.queueArn }) },
    });
    dlq.grantSendMessages(cleanup);
    new cw.Alarm(this, "DeadLetters", {
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new actions.SnsAction(topic));
    new cw.Alarm(this, "CleanupMissing", {
      metric: cleanup.metricInvocations({ period: cdk.Duration.days(1) }),
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.BREACHING,
    }).addAlarmAction(new actions.SnsAction(topic));
    new cw.Alarm(this, "ApiServerErrors", {
      metric: new cw.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5xx",
        dimensionsMap: { ApiId: this.api.apiId },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new actions.SnsAction(topic));
    new cdk.CfnOutput(this, "TableName", { value: this.table.tableName });
    new cdk.CfnOutput(this, "TableArn", { value: this.table.tableArn });
    new cdk.CfnOutput(this, "TableRegion", { value: this.region });
    new cdk.CfnOutput(this, "AlarmTopicArn", { value: topic.topicArn });
    new cdk.CfnOutput(this, "ApiEndpoint", { value: this.api.apiEndpoint });
  }
}
