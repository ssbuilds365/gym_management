const GST_STATES = Object.freeze({
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh'
});

const isValidStateCode = (stateCode) =>
  typeof stateCode === 'string' &&
  Object.prototype.hasOwnProperty.call(GST_STATES, stateCode);

const isValidGstin = (gstin) =>
  typeof gstin === 'string' &&
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) &&
  isValidStateCode(gstin.slice(0, 2));

const calculateGst = ({ configuredPrice, rate, inclusive, businessStateCode, placeOfSupplyStateCode }) => {
  const price = Number(configuredPrice);
  const gstRate = Number(rate);
  if (
    !Number.isSafeInteger(price) ||
    price < 0 ||
    !Number.isFinite(gstRate) ||
    gstRate < 0 ||
    gstRate > 100 ||
    !isValidStateCode(businessStateCode) ||
    !isValidStateCode(placeOfSupplyStateCode)
  ) {
    throw new Error('Invalid GST calculation input');
  }

  const rateBasisPoints = Math.round(gstRate * 100);
  const taxableAmount = inclusive
    ? Math.round((price * 10000) / (10000 + rateBasisPoints))
    : price;
  const totalTax = inclusive
    ? price - taxableAmount
    : Math.round((taxableAmount * rateBasisPoints) / 10000);
  const interstate = businessStateCode !== placeOfSupplyStateCode;
  const cgst = interstate ? 0 : Math.floor(totalTax / 2);
  const sgst = interstate ? 0 : totalTax - cgst;
  const igst = interstate ? totalTax : 0;

  return {
    taxableAmount,
    gstRate,
    cgst,
    sgst,
    igst,
    totalTax,
    totalAmount: taxableAmount + totalTax,
    inclusive: Boolean(inclusive),
    placeOfSupplyStateCode,
    componentMode: interstate ? 'IGST' : 'CGST_SGST'
  };
};

module.exports = {
  GST_STATES,
  isValidStateCode,
  isValidGstin,
  calculateGst
};
