import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { runtime } from "../service/runtime";
const c = runtime();
if (!c.endpoint)
  throw new Error("db:init only operates against DynamoDB Local.");
const db = new DynamoDBClient({
  endpoint: c.endpoint,
  region: "us-east-2",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
try {
  await db.send(new DescribeTableCommand({ TableName: c.table }));
  console.log("Local table already exists.");
} catch (e: any) {
  if (e.name !== "ResourceNotFoundException") throw e;
  await db.send(
    new CreateTableCommand({
      TableName: c.table,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        "pk",
        "sk",
        "gsi1pk",
        "gsi1sk",
        "gsi2pk",
        "gsi2sk",
      ].map((AttributeName) => ({ AttributeName, AttributeType: "S" })),
      GlobalSecondaryIndexes: [1, 2].map((i) => ({
        IndexName: `GSI${i}`,
        KeySchema: [
          { AttributeName: `gsi${i}pk`, KeyType: "HASH" },
          { AttributeName: `gsi${i}sk`, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      })),
    }),
  );
  await waitUntilTableExists(
    { client: db, maxWaitTime: 30 },
    { TableName: c.table },
  );
  console.log("Created local table.");
}
