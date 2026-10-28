// ISO 3166-1 alpha-2 assignments, including officially assigned territories.
// Keep code acceptance complete because campaign geographies already use ISO
// alpha-2; country-name aliases below remain deliberately conservative.
const ISO_ALPHA_2 = new Set(`
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
  BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
  CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
  DE DJ DK DM DO DZ
  EC EE EG EH ER ES ET
  FI FJ FK FM FO FR
  GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
  HK HM HN HR HT HU
  ID IE IL IM IN IO IQ IR IS IT
  JE JM JO JP
  KE KG KH KI KM KN KP KR KW KY KZ
  LA LB LC LI LK LR LS LT LU LV LY
  MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
  NA NC NE NF NG NI NL NO NP NR NU NZ
  OM
  PA PE PF PG PH PK PL PM PN PR PS PT PW PY
  QA
  RE RO RS RU RW
  SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
  TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
  UA UG UM US UY UZ
  VA VC VE VG VI VN VU
  WF WS
  YE YT
  ZA ZM ZW
`.trim().split(/\s+/));

// Exact-match names and common aliases only; never infer from prose fragments.
const COUNTRY_CODES = new Map([
  ['INDIA', 'IN'],
  ['USA', 'US'], ['UNITED STATES', 'US'], ['UNITED STATES OF AMERICA', 'US'],
  ['CANADA', 'CA'],
  ['UK', 'GB'], ['UNITED KINGDOM', 'GB'], ['GREAT BRITAIN', 'GB'],
  ['AUSTRALIA', 'AU'],
  ['GERMANY', 'DE'],
  ['FRANCE', 'FR'],
]);

/** Return an ISO alpha-2 code for a supported exact country name, alias, or code. */
export function countryClaimToIsoCode(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().replace(/\s+/g, ' ').toUpperCase();
  if (COUNTRY_CODES.has(key)) return COUNTRY_CODES.get(key);
  if (/^[A-Z]{2}$/.test(key)) return ISO_ALPHA_2.has(key) ? key : null;
  return null;
}
