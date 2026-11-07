import type { BackendStack } from "./backend-stack";
import * as cdk from "aws-cdk-lib";
import {
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
const projectRoot = resolve(__dirname, "../..");
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
    const prefix = "puncher";
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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; img-src 'self' data: https://googleusercontent.com https://*.googleusercontent.com; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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
        deploy.Source.asset(resolve(projectRoot, "dist/ui")),
        deploy.Source.data(
          "config.json",
          JSON.stringify({
            googleClientId: c.googleClientId,
            allowedDomain: "stmarobotics.org",
            timezone: "America/Chicago",
            statsUrl: c.statsUrl,
            localFixtures: false,
            walletEnabled: !!c.googleWalletClassId,
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
