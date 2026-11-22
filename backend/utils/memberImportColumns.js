const MEMBER_IMPORT_COLUMNS = Object.freeze([
  Object.freeze({ id: 'fullName', header: 'Member Name', required: true, type: 'string', aliases: ['member name', 'fullname', 'full name', 'name', 'customer name'] }),
  Object.freeze({ id: 'phone', header: 'Phone', required: true, type: 'phone', aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'contact', 'contact number'] }),
  Object.freeze({ id: 'email', header: 'Email', required: false, type: 'email', aliases: ['email', 'email address'] }),
  Object.freeze({ id: 'gender', header: 'Gender', required: false, type: 'enum', aliases: ['gender', 'sex'] })
]);

const APPLICATION_FIELDS = MEMBER_IMPORT_COLUMNS.map(column => column.id);

const normalizeHeader = value =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ');

const suggestMapping = headers => {
  const assigned = new Set();
  return headers.map(header => {
    const normalized = normalizeHeader(header);
    const column = MEMBER_IMPORT_COLUMNS.find(item =>
      normalizeHeader(item.header) === normalized ||
      item.aliases.some(alias => normalizeHeader(alias) === normalized)
    );
    if (!column || assigned.has(column.id)) return { header, field: '' };
    assigned.add(column.id);
    return { header, field: column.id };
  });
};

module.exports = {
  MEMBER_IMPORT_COLUMNS,
  APPLICATION_FIELDS,
  normalizeHeader,
  suggestMapping
};
