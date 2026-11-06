import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createHash, sign } from "node:crypto";
import { Fault, assert } from "./model";
import { runtime } from "./runtime";

type WalletServiceAccount = {
  client_email: string;
  private_key: string;
};

const ssm = new SSMClient({});
let cachedCredential: WalletServiceAccount | undefined;

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function walletCredential(value: string): WalletServiceAccount {
  let credential: WalletServiceAccount;
  try {
    credential = JSON.parse(value);
  } catch {
    throw new Fault(503, "Google Wallet signing credentials are invalid.");
  }
  assert(
    typeof credential?.client_email === "string" &&
      credential.client_email.length > 0 &&
      typeof credential.private_key === "string" &&
      credential.private_key.includes("PRIVATE KEY"),
    "Google Wallet signing credentials are invalid.",
    503,
  );
  return credential;
}

async function serviceAccount() {
  const c = runtime();
  if (c.local) {
    assert(
      process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON,
      "Google Wallet signing credentials are not configured.",
      503,
    );
    return walletCredential(process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON);
  }
  assert(
    c.googleWalletServiceAccountParameter,
    "Google Wallet signing credential parameter is not configured.",
    503,
  );
  if (cachedCredential) return cachedCredential;
  const parameter = await ssm.send(
    new GetParameterCommand({
      Name: c.googleWalletServiceAccountParameter,
      WithDecryption: true,
    }),
  );
  assert(
    parameter.Parameter?.Value,
    "Google Wallet signing credentials are unavailable.",
    503,
  );
  cachedCredential = walletCredential(parameter.Parameter.Value);
  return cachedCredential;
}

export function signWalletPass(
  credential: WalletServiceAccount,
  classId: string,
  memberId: string,
  barcode: string,
  origin: string,
  now = new Date(),
) {
  assert(
    /^\d+\.[A-Za-z0-9._-]+$/.test(classId),
    "Google Wallet class is not configured.",
    503,
  );
  assert(/^[0-9]{6}$/.test(barcode), "Invalid attendance barcode.", 403);
  const issuerId = classId.split(".", 1)[0];
  const objectSuffix =
    "member-" + createHash("sha256").update(memberId).digest("hex");
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: credential.client_email,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor(now.getTime() / 1000),
      origins: [new URL(origin).hostname],
      payload: {
        genericObjects: [
          {
            id: `${issuerId}.${objectSuffix}`,
            classId,
            state: "ACTIVE",
            cardTitle: {
              defaultValue: { language: "en-US", value: "STMA Robotics" },
            },
            header: {
              defaultValue: {
                language: "en-US",
                value: "Attendance barcode",
              },
            },
            barcode: { type: "CODE_128", value: barcode },
          },
        ],
      },
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), {
    key: credential.private_key,
    format: "pem",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

export async function walletSaveUrl(memberId: string, barcode: string) {
  const c = runtime();
  assert(c.googleWalletClassId, "Google Wallet is not configured.", 503);
  const credential = await serviceAccount();
  const token = signWalletPass(
    credential,
    c.googleWalletClassId,
    memberId,
    barcode,
    c.origin,
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}
