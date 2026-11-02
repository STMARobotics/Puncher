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
  aws_certificatemanager as acm,
  aws_route53 as dns,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as deploy,
  aws_cloudfront as cf,
  aws_cloudfront_origins as origins,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { resolve } from "node:path";
import type { Config } from "./config";
export class CertificateStack extends cdk.Stack {
  readonly certificate: acm.Certificate;
  constructor(scope: Construct, id: string, props: cdk.StackProps, c: Config) {
    super(scope, id, props);
    const zone = dns.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: c.zoneId,
      zoneName: c.zoneName,
    });
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: c.domain,
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
export class BackendStack extends cdk.Stack {
  readonly table: ddb.Table;
  readonly api: http.HttpApi;
  constructor(scope: Construct, id: string, props: cdk.StackProps, c: Config) {
    super(scope, id, props);
    const prefix = `puncher-${c.environment}`;
    this.table = new ddb.Table(this, "Records", {
      tableName: `${prefix}-records`,
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
        logGroupName: `/puncher/${c.environment}/${name}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const f = new nodejs.NodejsFunction(this, name, {
        functionName: `${prefix}-${name.toLowerCase()}`,
        entry: resolve(entry),
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
          APP_ENV: c.environment,
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
export class FrontendStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps,
    c: Config,
    backend: BackendStack,
    certificate: acm.ICertificate,
  ) {
    super(scope, id, props);
    const prefix = `puncher-${c.environment}`;
    const bucket = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const rewrite = new cf.Function(this, "FrontendRouting", {
      runtime: cf.FunctionRuntime.JS_2_0,
      code: cf.FunctionCode.fromInline(
        "function handler(e){var r=e.request;if(r.uri==='/api'||r.uri.indexOf('/api/')===0)return r;var last=r.uri.split('/').pop();if(r.uri==='/'||last.indexOf('.')<0)r.uri='/index.html';return r;}",
      ),
    });
    const security = new cf.ResponseHeadersPolicy(this, "Security", {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cf.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        frameOptions: {
          frameOption: cf.HeadersFrameOption.DENY,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy:
            "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; img-src 'self' data: https://*.googleusercontent.com; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            value: "camera=(self), microphone=()",
            override: true,
          },
        ],
      },
    });
    const dist = new cf.Distribution(this, "Distribution", {
      comment: prefix,
      domainNames: [c.domain],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: security,
        functionAssociations: [
          { function: rewrite, eventType: cf.FunctionEventType.VIEWER_REQUEST },
        ],
      },
    });
    const apiBehavior: cf.BehaviorOptions = {
      origin: new origins.HttpOrigin(
        cdk.Fn.select(2, cdk.Fn.split("/", backend.api.apiEndpoint)),
      ),
      viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cf.AllowedMethods.ALLOW_ALL,
      cachePolicy: cf.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: security,
    };
    dist.addBehavior("/api/*", apiBehavior.origin, apiBehavior);
    dist.addBehavior("/api", apiBehavior.origin, apiBehavior);
    new deploy.BucketDeployment(this, "Assets", {
      sources: [
        deploy.Source.asset(resolve("dist/ui")),
        deploy.Source.data(
          "config.json",
          JSON.stringify({
            googleClientId: c.googleClientId,
            allowedDomain: "stmarobotics.org",
            timezone: "America/Chicago",
            statsUrl: c.statsUrl,
            localFixtures: false,
          }),
        ),
      ],
      destinationBucket: bucket,
      distribution: dist,
      distributionPaths: ["/*"],
      cacheControl: [deploy.CacheControl.noCache()],
    });
    const zone = dns.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: c.zoneId,
      zoneName: c.zoneName,
    });
    new dns.ARecord(this, "Alias", {
      zone,
      recordName: c.domain,
      target: dns.RecordTarget.fromAlias(new targets.CloudFrontTarget(dist)),
    });
    new dns.AaaaRecord(this, "AliasIPv6", {
      zone,
      recordName: c.domain,
      target: dns.RecordTarget.fromAlias(new targets.CloudFrontTarget(dist)),
    });
    new cdk.CfnOutput(this, "URL", { value: `https://${c.domain}` });
  }
}
export class DeploymentIdentityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps, c: Config) {
    super(scope, id, props);
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GithubProvider",
      `arn:aws:iam::${c.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const role = new iam.Role(this, "DeploymentRole", {
      roleName: `puncher-${c.environment}-github-deploy`,
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": `repo:${c.repository}:environment:puncher-${c.environment}`,
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${c.account}:role/cdk-puncher-*-${c.account}-us-east-1`,
          `arn:aws:iam::${c.account}:role/cdk-puncher-*-${c.account}-us-east-2`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:cloudformation:*:${c.account}:stack/puncher-*/*`,
          `arn:aws:cloudformation:*:${c.account}:stack/CDKToolkit-Puncher/*`,
        ],
      }),
    );
    new cdk.CfnOutput(this, "RoleArn", { value: role.roleArn });
  }
}
