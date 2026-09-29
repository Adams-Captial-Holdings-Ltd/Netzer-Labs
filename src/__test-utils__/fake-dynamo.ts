/**
 * A minimal in-memory stand-in for the DynamoDB document client, so a unit test
 * can follow a sequence of writes end to end — what a conversation row holds,
 * what each message record holds, what a delete leaves behind.
 *
 * It answers the command shapes the sessions repository sends, keyed by PK+SK
 * in one table. The only condition it evaluates is a lone key-existence check
 * (`attribute_exists(PK)` and the like) on a standalone Put or Update; it does
 * NOT apply update expressions, evaluate any other condition, filter or
 * projection, or page: prove those against Floci in an *.integration.test.ts,
 * where DynamoDB's own semantics apply.
 */

type Row = Record<string, unknown>;
type Command = { constructor: { name: string }; input: Record<string, any> };

export function createFakeDynamo() {
  const rows = new Map<string, Row>();
  const keyOf = (k: Row) => `${String(k.PK)}|${String(k.SK)}`;

  function write(t: { Put?: { Item: Row }; Delete?: { Key: Row } }) {
    if (t.Put) rows.set(keyOf(t.Put.Item), t.Put.Item);
    if (t.Delete) rows.delete(keyOf(t.Delete.Key));
  }

  /** Throw as DynamoDB does when a lone key-existence condition does not hold. */
  function checkExists(condition: unknown, key: Row) {
    const m = /^attribute_(not_)?exists\((?:PK|SK)\)$/.exec(String(condition ?? ''));
    if (m && rows.has(keyOf(key)) === Boolean(m[1])) {
      throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    }
  }

  async function send(cmd: Command): Promise<Record<string, unknown>> {
    const input = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: rows.get(keyOf(input.Key)) };
      case 'PutCommand':
        checkExists(input.ConditionExpression, input.Item);
        write({ Put: { Item: input.Item } });
        return {};
      case 'DeleteCommand':
        write({ Delete: { Key: input.Key } });
        return {};
      case 'UpdateCommand':
        // The update itself is not applied; tests that need its effect assert on
        // the command, or run against Floci.
        checkExists(input.ConditionExpression, input.Key);
        return {};
      case 'TransactWriteCommand':
        for (const t of input.TransactItems) write(t);
        return {};
      case 'BatchWriteCommand':
        for (const reqs of Object.values(input.RequestItems) as Array<Array<{ DeleteRequest?: { Key: Row }; PutRequest?: { Item: Row } }>>) {
          for (const r of reqs) {
            if (r.DeleteRequest) write({ Delete: { Key: r.DeleteRequest.Key } });
            if (r.PutRequest) write({ Put: { Item: r.PutRequest.Item } });
          }
        }
        return {};
      case 'QueryCommand': {
        const v = input.ExpressionAttributeValues as Record<string, string>;
        const items = [...rows.values()]
          .filter((i) => i.PK === v[':pk'] && String(i.SK).startsWith(v[':prefix'] ?? ''))
          .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
        return { Items: input.ScanIndexForward === false ? items.reverse() : items };
      }
      case 'ScanCommand':
        return { Items: [...rows.values()] };
      default:
        throw new Error(`fake-dynamo: unexpected command ${cmd.constructor.name}`);
    }
  }

  return { rows, send };
}
