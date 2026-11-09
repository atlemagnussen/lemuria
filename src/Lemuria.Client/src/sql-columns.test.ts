// Run: npm test   (Node's built-in runner; Node >= 23.6 runs .ts directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeColumns, type ColumnOptions } from './sql-columns.ts';

const schema = {
  schemas: [
    {
      name: 'dbo',
      objects: [
        {
          name: 'Orders', type: 'table',
          columns: [col('Id'), col('CustomerId'), col('OrderDate', 'datetime2'), col('Total', 'decimal')],
        },
        { name: 'Customers', type: 'table', columns: [col('Id'), col('Name', 'nvarchar'), col('Order Count')] },
      ],
    },
    { name: 'sales', objects: [{ name: 'Invoices', type: 'table', columns: [col('InvoiceNo'), col('Amount')] }] },
  ],
};

function col(name: string, dataType = 'int') {
  return { name, dataType, nullable: true, isPrimaryKey: false };
}

const opts: ColumnOptions = { defaultSchema: 'dbo', quoting: 'brackets' };

/** `|` marks the cursor. Returns the text each option inserts, or null when nothing is offered. */
function labels(sqlWithCursor: string, o: Partial<ColumnOptions> = {}) {
  const pos = sqlWithCursor.indexOf('|');
  const doc = sqlWithCursor.slice(0, pos) + sqlWithCursor.slice(pos + 1);
  return completeColumns(doc, pos, schema, { ...opts, ...o })?.options.map((x) => x.insert) ?? null;
}

const orderCols = ['Id', 'CustomerId', 'OrderDate', 'Total'];

test('SELECT list before an existing FROM', () => {
  assert.deepEqual(labels('SELECT Or| FROM Orders'), orderCols);
  assert.deepEqual(labels('SELECT Id, Cu| FROM Orders'), orderCols);
  assert.deepEqual(labels('SELECT TOP 10 T| FROM dbo.Orders'), orderCols);
  assert.deepEqual(labels('SELECT TOP (10) T| FROM Orders'), orderCols);
  assert.deepEqual(labels('SELECT DISTINCT C| FROM Orders'), orderCols);
});

test('WHERE, AND/OR, comparisons, ORDER BY, GROUP BY', () => {
  assert.deepEqual(labels('SELECT * FROM Orders WHERE T|'), orderCols);
  assert.deepEqual(labels('SELECT * FROM Orders WHERE Id = 1 AND C|'), orderCols);
  assert.deepEqual(labels('SELECT * FROM Orders WHERE Total > O|'), orderCols);
  assert.deepEqual(labels('SELECT * FROM Orders ORDER BY O|'), orderCols);
  assert.deepEqual(labels('SELECT CustomerId, COUNT(*) FROM Orders GROUP BY C|'), orderCols);
  assert.deepEqual(labels('SELECT * FROM Orders WHERE Id IN (C|'), orderCols);
});

test('explicit completion with an empty word', () => {
  assert.equal(labels('SELECT * FROM Orders WHERE |'), null);
  assert.deepEqual(labels('SELECT * FROM Orders WHERE |', { explicit: true }), orderCols);
});

test('aliases and schemas', () => {
  assert.deepEqual(labels('SELECT * FROM Orders o WHERE T|'), orderCols);
  assert.deepEqual(labels('SELECT * FROM Orders AS o WHERE T|'), orderCols);
  assert.deepEqual(labels('SELECT * FROM [dbo].[Orders] WITH (NOLOCK) WHERE T|'), orderCols);
  assert.deepEqual(labels('SELECT A| FROM sales.Invoices'), ['InvoiceNo', 'Amount']);
  assert.deepEqual(labels('SELECT A| FROM Invoices'), ['InvoiceNo', 'Amount']); // found outside default schema
  assert.deepEqual(labels('select t| from orders'), orderCols); // case-insensitive names
});

test('join: shared names are qualified, unique ones are not', () => {
  assert.deepEqual(labels('SELECT N| FROM Orders o JOIN Customers c ON c.Id = o.CustomerId'), [
    'o.Id', 'CustomerId', 'OrderDate', 'Total', 'c.Id', 'Name', '[Order Count]',
  ]);
  assert.deepEqual(labels('SELECT * FROM Orders o JOIN Customers c ON C|')?.length, 7);
  // Matching uses the bare column name, so typing "Id" finds both o.Id and c.Id.
  const doc = 'SELECT Id FROM Orders o JOIN Customers c ON 1=1';
  const ids = completeColumns(doc, 9, schema, opts)!.options.filter((x) => x.label === 'Id');
  assert.deepEqual(ids.map((x) => x.insert), ['o.Id', 'c.Id']);
  assert.deepEqual(labels('SELECT * FROM Orders, Customers WHERE N|')?.includes('Orders.Id'), true);
});

test('quoting follows the dialect', () => {
  assert.ok(labels('SELECT O| FROM Customers')!.includes('[Order Count]'));
  assert.ok(labels('SELECT O| FROM Customers', { quoting: 'double' })!.includes('"Order Count"'));
});

test('no columns where a table name or alias goes', () => {
  assert.equal(labels('SELECT * FROM O|'), null);
  assert.equal(labels('SELECT * FROM Orders o JOIN C|'), null);
  assert.equal(labels('SELECT * FROM Orders, C|'), null);
  assert.equal(labels('SELECT * FROM Orders o|'), null);
  assert.equal(labels('SELECT Id A|'), null); // alias position
});

test('qualified names are left to lang-sql', () => {
  assert.equal(labels('SELECT o.| FROM Orders o'), null);
  assert.equal(labels('SELECT o.T| FROM Orders o'), null);
});

test('not inside strings or comments', () => {
  assert.equal(labels("SELECT * FROM Orders WHERE Name = 'T|"), null);
  assert.equal(labels('SELECT * FROM Orders WHERE -- T|'), null);
  assert.equal(labels('SELECT * FROM Orders WHERE /* T|'), null);
  assert.deepEqual(labels("SELECT * FROM Orders WHERE Name = 'x' AND T|"), orderCols);
});

test('only the statement under the cursor counts', () => {
  assert.deepEqual(labels('SELECT * FROM Customers;\nSELECT T| FROM Orders'), orderCols);
  assert.deepEqual(labels('SELECT T| FROM Orders;\nSELECT * FROM Customers'), orderCols);
  assert.deepEqual(labels('SELECT * FROM Customers\nGO\nSELECT T| FROM Orders\ngo\nSELECT 1'), orderCols);
  assert.equal(labels("SELECT * FROM Customers WHERE Name = 'a;b'\nGO\nSELECT T|"), null); // no FROM yet
});

test('no FROM or unknown table: nothing to offer', () => {
  assert.equal(labels('SELECT T|'), null);
  assert.equal(labels('SELECT T| FROM NoSuchTable'), null);
});

test('UPDATE ... SET and WHERE', () => {
  assert.deepEqual(labels('UPDATE Orders SET T|'), orderCols);
  assert.deepEqual(labels('UPDATE Orders SET Total = 0 WHERE I|'), orderCols);
  assert.deepEqual(labels('DELETE FROM Orders WHERE I|'), orderCols);
});
