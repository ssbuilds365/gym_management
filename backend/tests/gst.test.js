const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateGst,
  isValidGstin,
  isValidStateCode
} = require('../utils/gst');

test('inclusive GST extracts tax from the configured total price', () => {
  const result = calculateGst({
    configuredPrice: 11800,
    rate: 18,
    inclusive: true,
    businessStateCode: '27',
    placeOfSupplyStateCode: '27'
  });

  assert.deepEqual(result, {
    taxableAmount: 10000,
    gstRate: 18,
    cgst: 900,
    sgst: 900,
    igst: 0,
    totalTax: 1800,
    totalAmount: 11800,
    inclusive: true,
    placeOfSupplyStateCode: '27',
    componentMode: 'CGST_SGST'
  });
});

test('exclusive GST adds IGST for an interstate supply', () => {
  const result = calculateGst({
    configuredPrice: 10000,
    rate: 18,
    inclusive: false,
    businessStateCode: '27',
    placeOfSupplyStateCode: '29'
  });

  assert.equal(result.taxableAmount, 10000);
  assert.equal(result.totalTax, 1800);
  assert.equal(result.totalAmount, 11800);
  assert.equal(result.cgst, 0);
  assert.equal(result.sgst, 0);
  assert.equal(result.igst, 1800);
  assert.equal(result.componentMode, 'IGST');
});

test('GST calculations reject invalid state codes and rates', () => {
  assert.throws(() => calculateGst({
    configuredPrice: 10000,
    rate: 18,
    inclusive: false,
    businessStateCode: '27',
    placeOfSupplyStateCode: '25'
  }), /Invalid GST calculation input/);
  assert.equal(isValidStateCode('27'), true);
  assert.equal(isValidStateCode('25'), false);
});

test('GSTIN validation checks structure and state prefix without claiming registration verification', () => {
  assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
  assert.equal(isValidGstin('25AAPFU0939F1ZV'), false);
  assert.equal(isValidGstin('invalid'), false);
});
