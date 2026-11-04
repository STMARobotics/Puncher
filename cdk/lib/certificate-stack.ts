import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dns from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
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
