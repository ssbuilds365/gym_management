const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const XLSX = require('xlsx');
const { PassThrough } = require('node:stream');

const Member = require('../models/Member');
const MembershipPlan = require('../models/MembershipPlan');
const Business = require('../models/Business');
const memberImport = require('../controllers/memberImportController');
const memberRoutes = require('../routes/memberRoutes');
const { MEMBER_IMPORT_COLUMNS } = require('../utils/memberImportColumns');

const makeWorkbook = (headers, rows, bookType) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows]),
    'Members'
  );
  return XLSX.write(workbook, { type: 'buffer', bookType });
};

const uploadFile = async (baseUrl, filename, content, mimeType, mapping) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type: mimeType }), filename);
  if (mapping) form.append('mapping', JSON.stringify(mapping));
  const response = await fetch(`${baseUrl}/preview`, { method: 'POST', body: form });
  return { response, body: await response.json() };
};

test('member import upload accepts supported formats and rejects invalid contents', async t => {
  const originalFind = Member.find;
  const originalPlanFind = MembershipPlan.find;
  const originalBusinessFindById = Business.findById;
  Member.find = () => ({
    select: () => ({ lean: async () => [] })
  });
  MembershipPlan.find = () => ({
    select: () => ({ lean: async () => [] }),
    sort: () => ({ lean: async () => [] })
  });
  Business.findById = () => ({
    lean: async () => ({ timeZone: 'Asia/Kolkata', gstEnabled: false })
  });

  const app = express();
  app.post('/preview', (req, res, next) => {
    req.tenantId = 'tenant-test';
    req.owner = { _id: 'owner-test', businessId: 'business-test' };
    next();
  }, memberRoutes.handleImportUpload, memberImport.previewMemberImport);

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await t.test('valid XLSX works when the browser MIME hint is nonstandard', async () => {
      const content = makeWorkbook(
        ['Member Name', 'Phone Number'],
        [['Asha', '9876543210'], ['Invalid Row', '123']],
        'xlsx'
      );
      const { response, body } = await uploadFile(
        baseUrl,
        'members.xlsx',
        content,
        'application/x-zip-compressed'
      );

      assert.equal(response.status, 200);
      assert.equal(body.validRecords, 1);
      assert.equal(body.invalidRecords, 1);
    });

    await t.test('valid XLS uploads', async () => {
      const content = makeWorkbook(
        ['Member Name', 'Phone Number'],
        [['Ravi', '9876543211']],
        'xls'
      );
      const { response, body } = await uploadFile(
        baseUrl,
        'members.xls',
        content,
        'application/vnd.ms-excel'
      );

      assert.equal(response.status, 200);
      assert.equal(body.validRecords, 1);
    });

    await t.test('valid CSV uploads', async () => {
      const content = Buffer.from('Member Name,Phone Number\r\nMina,9876543212\r\n');
      const { response, body } = await uploadFile(
        baseUrl,
        'members.csv',
        content,
        'text/csv'
      );

      assert.equal(response.status, 200);
      assert.equal(body.validRecords, 1);
    });

    await t.test('empty Excel workbook reports an empty file', async () => {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Members');
      const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const { response, body } = await uploadFile(
        baseUrl,
        'empty.xlsx',
        content,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      assert.equal(response.status, 400);
      assert.equal(body.message, 'The uploaded file is empty.');
    });

    await t.test('non-Excel content renamed to XLSX is rejected', async () => {
      const { response, body } = await uploadFile(
        baseUrl,
        'renamed.xlsx',
        Buffer.from('not an Excel workbook'),
        'application/octet-stream'
      );

      assert.equal(response.status, 400);
      assert.match(body.message, /Invalid Excel file/);
    });

    await t.test('malformed Excel content reports a parsing error', async () => {
      const { response, body } = await uploadFile(
        baseUrl,
        'malformed.xlsx',
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
        'application/octet-stream'
      );

      assert.equal(response.status, 400);
      assert.match(body.message, /Excel parsing failed|Invalid Excel file/);
    });

    await t.test('the exact downloaded application template parses without duplicate mappings', async () => {
      const stream = new PassThrough();
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.setHeader = () => {};
      const completed = new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      await memberImport.downloadMemberImportTemplate(
        {
          tenantId: 'tenant-test',
          owner: { _id: 'owner-test', businessId: 'business-test' }
        },
        stream
      );
      await completed;

      const buffer = Buffer.concat(chunks);
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheet = workbook.Sheets['Members'];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const generatedHeaders = rows[0].map(value => String(value));

      assert.deepEqual(
        generatedHeaders,
        MEMBER_IMPORT_COLUMNS.map(column => column.header)
      );
      assert.equal(generatedHeaders.includes('Member ID'), false);
      assert.equal(generatedHeaders.length, new Set(generatedHeaders.map(value =>
        value.trim().toLowerCase()
      )).size);
      assert.deepEqual(workbook.SheetNames, ['Members']);
      assert.equal(generatedHeaders.length, 4);

      const { response, body } = await uploadFile(
        baseUrl,
        'member-import-template.xlsx',
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      assert.equal(response.status, 200);
      assert.equal(body.records.length, 1);
      assert.equal(body.validRecords, 1);
      assert.equal(body.mappings.filter(item => item.field === 'phone').length, 1);
      assert.equal(body.mappings.filter(item => item.field === 'fullName').length, 1);
    });

    await t.test('recognized aliases work automatically without mapping', async () => {
      const content = makeWorkbook(
        ['Customer Name', 'Mobile Number'],
        [['Nila', '9876543213']],
        'xlsx'
      );
      const firstUpload = await uploadFile(
        baseUrl,
        'aliases.xlsx',
        content,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        [{ header: 'Customer Name', field: 'fullName' }, { header: 'Mobile Number', field: 'phone' }]
      );

      assert.equal(firstUpload.response.status, 200);
      assert.equal(firstUpload.body.validRecords, 1);
      assert.equal(firstUpload.body.records[0].fullName, 'Nila');
    });

    await t.test('missing required mappings and unsupported extensions have clear errors', async () => {
      const content = makeWorkbook(['Client', 'Cell'], [['Nila', '9876543214']], 'xlsx');
      const missingMapping = await uploadFile(
        baseUrl,
        'custom-headers.xlsx',
        content,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        [{ header: 'Client', field: '' }, { header: 'Cell', field: '' }]
      );
      assert.equal(missingMapping.response.status, 400);
      assert.match(missingMapping.body.message, /Missing required column/);

      const unsupported = await uploadFile(
        baseUrl,
        'members.txt',
        Buffer.from('not a spreadsheet'),
        'text/plain'
      );
      assert.equal(unsupported.response.status, 400);
      assert.match(unsupported.body.message, /Unsupported file extension/);
    });

    await t.test('uploads over the configured size limit are rejected', async () => {
      const { response, body } = await uploadFile(
        baseUrl,
        'too-large.csv',
        Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
        'text/csv'
      );

      assert.equal(response.status, 400);
      assert.equal(body.message, 'The file exceeds the 10 MB size limit.');
    });
  } finally {
    Member.find = originalFind;
    MembershipPlan.find = originalPlanFind;
    Business.findById = originalBusinessFindById;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
