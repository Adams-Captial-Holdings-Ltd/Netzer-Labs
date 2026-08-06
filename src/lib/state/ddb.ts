/**
 * DynamoDB DocumentClient singleton.
 *
 * Module-level instance; reuse across the process. Region comes from
 * AWS_REGION (injected by ECS at task start).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { captureAwsClient } from '../observability/xray.js';

const region = process.env.AWS_REGION ?? 'us-east-1';

let _doc: DynamoDBDocumentClient | null = null;

export function ddb(): DynamoDBDocumentClient {
  if (!_doc) {
    const raw = captureAwsClient(new DynamoDBClient({ region }));
    _doc = DynamoDBDocumentClient.from(raw, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
    });
  }
  return _doc;
}

/** Test helper: reset the cached client. */
export function resetDdbCache(): void {
  _doc = null;
}
