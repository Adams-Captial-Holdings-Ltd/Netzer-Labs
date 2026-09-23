/**
 * A minimal in-memory stand-in for the DynamoDB document client, so a unit test
 * can follow a sequence of writes end to end — what a conversation row holds,
 * what each message record holds, what a delete leaves behind.
 *
 * It answers the command shapes the sessions repository sends, keyed by PK+SK
 * in one table. It does NOT evaluate condition, filter or projection
 * expressions, and it never pages: prove those against Floci in an
 * *.integration.test.ts, where DynamoDB's own semantics apply.
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

  async function send(cmd: Command): Promise<Record<string, unknown>> {
    const input = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: rows.get(keyOf(input.Key)) };
      case 'PutCommand':
        write({ Put: { Item: input.Item } });
        return {};
      case 'DeleteCommand':
        write({ Delete: { Key: input.Key } });
        return {};
      case 'UpdateCommand':
        // Only the shapes this repo sends are needed; tests that exercise an
        // UpdateCommand assert on the command itself.
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
