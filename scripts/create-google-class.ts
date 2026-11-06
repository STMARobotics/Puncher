import { JWT } from "google-auth-library";
import { assert } from "../service/model";

const classId = process.argv[2];
assert(
  classId && /^[0-9]+\.[A-Za-z0-9._-]+$/.test(classId),
  "Usage: npm run wallet:create-class -- ISSUER_ID.CLASS_SUFFIX",
);

const credentialJson = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON;
assert(
  credentialJson,
  "Set GOOGLE_WALLET_SERVICE_ACCOUNT_JSON to the service account JSON in .env.",
);

let credentials: { client_email?: string; private_key?: string };
try {
  credentials = JSON.parse(credentialJson);
} catch {
  throw new Error("GOOGLE_WALLET_SERVICE_ACCOUNT_JSON is not valid JSON.");
}
assert(
  credentials.client_email && credentials.private_key?.includes("PRIVATE KEY"),
  "Wallet service account JSON must include client_email and private_key.",
);

const auth = new JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/wallet_object.issuer"],
});
const { token } = await auth.getAccessToken();
assert(token, "Could not obtain a Google Wallet API access token.", 503);

const result = await fetch(
  "https://walletobjects.googleapis.com/walletobjects/v1/genericClass",
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: classId }),
  },
);
if (result.status === 409) {
  const existing = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/genericClass/${encodeURIComponent(classId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!existing.ok) {
    const details = await existing.text();
    throw new Error(
      `The class ID already exists, but Google could not find it as a Generic class (${existing.status}): ${details}`,
    );
  }
  const found = (await existing.json()) as { id?: string };
  assert(found.id === classId, "Google returned an unexpected class ID.", 502);
  console.log(`Generic class already exists: ${found.id}`);
} else if (!result.ok) {
  const details = await result.text();
  throw new Error(
    `Google Wallet class creation failed (${result.status}): ${details}`,
  );
} else {
  const created = (await result.json()) as { id?: string };
  assert(
    created.id === classId,
    "Google returned an unexpected class ID.",
    502,
  );
  console.log(`Created Generic class: ${created.id}`);
}
